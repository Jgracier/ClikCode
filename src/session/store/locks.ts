/** Lock files that survive a killed process. A lock records its owner, and a
 * lock whose owner is gone is broken rather than waited on forever. */

import { randomBytes } from 'node:crypto';
import { link, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { ensurePrivateDirectory } from './files.js';
import { stateDirectory } from './paths.js';

class StateLockTimeoutError extends Error {
  constructor(lockPath: string, holder: string | undefined, waitedMs: number) {
    super(`ClikCode could not lock its local state after ${Math.round(waitedMs / 1000)}s (${lockPath}${holder ? `, held by ${holder}` : ''}). `
      + 'Nothing was written. If no other ClikCode process is running, delete that lock file and retry.');
    this.name = 'StateLockTimeoutError';
  }
}

export function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface LockOwner { pid: number; host: string; nonce: string; at: string }

const LOCK_TUNING = {
  /** A holder on another machine (shared home) can only be judged by age. */
  staleMs: 30_000,
  /** A live local pid is trusted this long before pid reuse is suspected. */
  livePidStaleMs: 5 * 60_000,
  /** Writes wait this long, then fail loudly. They never proceed unlocked. */
  waitMs: 30_000,
};

const lockQueues = new Map<string, Promise<unknown>>();

function parseLockOwner(raw: string): LockOwner | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<LockOwner>;
    return typeof parsed.pid === 'number' && typeof parsed.nonce === 'string' && typeof parsed.host === 'string'
      ? parsed as LockOwner : undefined;
  } catch {
    // fail-open-ok: malformed lock metadata cannot identify a live owner; age still governs stale-lock handling
    return undefined;
  }
}

async function lockLooksStale(lockPath: string, raw: string): Promise<boolean> {
  const age = await stat(lockPath).then((info) => Date.now() - info.mtimeMs).catch(() => undefined);
  if (age === undefined) return false; // Already gone; the open will simply succeed.
  const owner = parseLockOwner(raw);
  // An empty file is a holder between create and write; only age condemns it.
  if (!owner) return age > LOCK_TUNING.staleMs;
  if (owner.host === hostname()) return pidIsAlive(owner.pid) ? age > LOCK_TUNING.livePidStaleMs : true;
  return age > LOCK_TUNING.staleMs;
}

/** Removes a stale lock without ever removing a fresh one.
 *
 * Unlinking by path is racy: two waiters both judge the lock stale, the first
 * unlinks and re-acquires, the second then unlinks the *fresh* lock. Renaming
 * to a private name is atomic, so exactly one waiter takes the file; it then
 * checks that what it took is the lock it judged, and puts it back otherwise. */
export async function breakStaleLock(lockPath: string, observedRaw: string): Promise<void> {
  const current = await readFile(lockPath, 'utf8').catch(() => undefined);
  if (current !== observedRaw) return;
  const aside = `${lockPath}.${process.pid}.${randomBytes(6).toString('hex')}.stale`;
  try {
    await rename(lockPath, aside);
  } catch {
    return; // Another waiter already took it.
  }
  const taken = await readFile(aside, 'utf8').catch(() => undefined);
  if (taken !== observedRaw) await link(aside, lockPath).catch(() => undefined);
  await unlink(aside).catch(() => undefined);
}

/** Cross-process mutual exclusion on `lockPath`, serialized in-process first so
 * one process never contends with itself. Not re-entrant: code that needs a
 * lock its caller already holds takes proof of it as a parameter instead
 * (StateLockHeld). Implicit re-entrancy (AsyncLocalStorage) was tried and
 * removed: promises started inside a locked section inherited the "held"
 * mark after the section had released, and sibling tasks in one chain ran
 * past each other. */
export async function withFileLock<T>(lockPath: string, run: () => Promise<T>): Promise<T> {
  const previous = lockQueues.get(lockPath) ?? Promise.resolve();
  const result = previous.then(() => holdFileLock(lockPath, run));
  const settled = result.catch(() => undefined);
  lockQueues.set(lockPath, settled);
  void settled.then(() => { if (lockQueues.get(lockPath) === settled) lockQueues.delete(lockPath); });
  return result;
}

/** Resolves at a moment this process holds and awaits no file lock. A caller
 * that then replaces the process synchronously (execve) leaves no lock behind
 * under a pid that stays alive -- such a lock is trusted for minutes and stalls
 * every other ClikCode. */
export async function fileLocksIdle(): Promise<void> {
  while (lockQueues.size) await Promise.all([...lockQueues.values()]);
}

/** Whether this process holds, or is waiting for, any file lock right now. */
export function fileLocksHeld(): boolean {
  return lockQueues.size > 0;
}

async function holdFileLock<T>(lockPath: string, run: () => Promise<T>): Promise<T> {
  await ensurePrivateDirectory(dirname(lockPath));
  const owner: LockOwner = { pid: process.pid, host: hostname(), nonce: randomBytes(12).toString('hex'), at: new Date().toISOString() };
  const mine = JSON.stringify(owner);
  const started = Date.now();
  let holder: string | undefined;
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try { await handle.writeFile(mine, 'utf8'); } finally { await handle.close(); }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const raw = await readFile(lockPath, 'utf8').catch(() => undefined);
    if (raw !== undefined) {
      const other = parseLockOwner(raw);
      holder = other ? `pid ${other.pid} on ${other.host}` : undefined;
      if (await lockLooksStale(lockPath, raw)) {
        await breakStaleLock(lockPath, raw);
        continue;
      }
    }
    const waited = Date.now() - started;
    // Proceeding without the lock would make the read-merge-write below
    // non-atomic and silently drop another terminal's work. Refuse instead.
    if (waited > LOCK_TUNING.waitMs) throw new StateLockTimeoutError(lockPath, holder, waited);
    await new Promise((resolve) => setTimeout(resolve, 8 + Math.floor(Math.random() * 12)));
  }
  try {
    return await run();
  } finally {
    // Only ever remove our own lock: if it was judged stale and replaced while
    // we ran, the file now belongs to someone else.
    const current = await readFile(lockPath, 'utf8').catch(() => undefined);
    if (current === mine) await unlink(lockPath).catch(() => undefined);
  }
}

/** Same path the single-file layout used, so an older build still running in
 * another terminal keeps excluding with this one during an upgrade. */
function stateLockPath(): string {
  return join(stateDirectory(), 'harness-state.json.lock');
}

declare const stateLockBrand: unique symbol;
/** Proof, passed down explicitly, that the caller holds the state lock. Only
 * withStateLock makes one. Functions that must run under the state lock
 * (transcript writes, migration) take it as a parameter, so holding the lock
 * is checked by the compiler and nothing ever re-takes it. */
export type StateLockHeld = { readonly [stateLockBrand]: true };
const STATE_LOCK_HELD = Object.freeze({}) as StateLockHeld;

/** The one lock every index and transcript write runs under. Order is always
 * state lock first, then any session lock -- never the reverse. */
export function withStateLock<T>(run: (held: StateLockHeld) => Promise<T>): Promise<T> {
  return withFileLock(stateLockPath(), () => run(STATE_LOCK_HELD));
}
