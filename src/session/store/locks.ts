/** Lock files that survive a killed process. A lock records its owner, and a
 * lock whose owner is gone is broken rather than waited on forever. */

import { randomBytes } from 'node:crypto';
import { link, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { ensurePrivateDirectory } from './files.js';
import { safeRecordFileName, sessionsDirectory, stateDirectory } from './paths.js';

export class StateLockTimeoutError extends Error {
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

export const LOCK_TUNING = {
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
async function breakStaleLock(lockPath: string, observedRaw: string): Promise<void> {
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
 * one process never contends with itself. Not re-entrant. */
export async function withFileLock<T>(lockPath: string, run: () => Promise<T>): Promise<T> {
  const previous = lockQueues.get(lockPath) ?? Promise.resolve();
  const result = previous.then(() => holdFileLock(lockPath, run));
  const settled = result.catch(() => undefined);
  lockQueues.set(lockPath, settled);
  void settled.then(() => { if (lockQueues.get(lockPath) === settled) lockQueues.delete(lockPath); });
  return result;
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
export function stateLockPath(): string {
  return join(stateDirectory(), 'harness-state.json.lock');
}

export function withStateLock<T>(run: () => Promise<T>): Promise<T> {
  return withFileLock(stateLockPath(), run);
}

export function withSessionLock<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
  return withFileLock(join(sessionsDirectory(), `${safeRecordFileName(sessionId)}.lock`), run);
}
