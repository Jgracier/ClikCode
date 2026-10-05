/** Lock files that survive a killed process. A lock records its owner and is
 * kept fresh while held; one that stops being refreshed, or whose owner is
 * visibly gone, is broken rather than waited on forever. */

import { randomBytes } from 'node:crypto';
import { readlinkSync } from 'node:fs';
import { link, open, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { lifecycle } from '../../runtime/lifecycle-log.js';
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

/** `pidns` is this process's pid namespace (Linux): a pid only means
 * something to a process in the same one. */
interface LockOwner { pid: number; host: string; nonce: string; at: string; pidns?: string }

/** Exported for tests only; production code never changes these. */
export const LOCK_TUNING = {
  /** A lock whose file has not been refreshed for this long is stale. */
  staleMs: 30_000,
  /** A lock file with no readable owner is stale this soon. A lock is
   * created with its owner already in it (createLock), so only an older
   * build -- open, then write -- shows one empty, for the moment between
   * the two steps; one that stays empty was left by a process killed
   * there, and waiting staleMs on it stood a VS Code send 30 s. */
  ownerlessStaleMs: 1_000,
  /** A holder refreshes its lock file's mtime this often... */
  heartbeatMs: 10_000,
  /** ...for at most this long. A holder stuck past it stops refreshing, and
   * is broken staleMs later rather than stalling every ClikCode forever. */
  maxHoldMs: 5 * 60_000,
  /** Writes wait this long, then fail loudly. They never proceed unlocked. */
  waitMs: 30_000,
};

const lockQueues = new Map<string, Promise<unknown>>();

let ownPidNamespace: string | null | undefined;
function pidNamespace(): string | undefined {
  if (ownPidNamespace === undefined) {
    try { ownPidNamespace = readlinkSync('/proc/self/ns/pid'); } catch { ownPidNamespace = null; }
  }
  return ownPidNamespace ?? undefined;
}

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

/** A held lock is refreshed (heartbeat), so staleness is its file's age --
 * whatever host or pid namespace the holder is in. Two shortcuts: a lock
 * with no readable owner is stale after ownerlessStaleMs, and a holder this
 * process can see is dead (same host, same pid namespace, pid gone) is stale
 * at once. A pid that merely is not visible -- a holder in
 * another container -- says nothing; only the heartbeat does. An owner
 * written without `pidns` (an older build) is judged as one in ours. */
export async function lockLooksStale(lockPath: string, raw: string): Promise<boolean> {
  const age = await stat(lockPath).then((info) => Date.now() - info.mtimeMs).catch(() => undefined);
  if (age === undefined) return false; // Already gone; the open will simply succeed.
  if (age > LOCK_TUNING.staleMs) return true;
  const owner = parseLockOwner(raw);
  if (!owner) return age > LOCK_TUNING.ownerlessStaleMs;
  if (owner.host !== hostname()) return false;
  if (owner.pidns !== undefined && owner.pidns !== pidNamespace()) return false;
  return !pidIsAlive(owner.pid);
}

/** Removes a stale lock without ever removing a fresh one.
 *
 * Unlinking by path is racy: two waiters both judge the lock stale, the first
 * unlinks and re-acquires, the second then unlinks the *fresh* lock. So
 * breakers take turns (`.breaking`, created exclusively, held for a few file
 * operations); the one whose turn it is re-checks that the file is still the
 * one judged -- same content, and, with `stillStale`, still stale (a holder
 * may have heartbeated since) -- then renames it aside and checks by inode
 * that what it took is that file, putting it back otherwise. Without turns,
 * a second breaker could take a fresh lock and fail to put it back (a third
 * waiter having created one meanwhile): two holders. */
export async function breakStaleLock(lockPath: string, observedRaw: string, stillStale?: (raw: string) => Promise<boolean>): Promise<void> {
  const breaking = `${lockPath}.breaking`;
  try {
    await (await open(breaking, 'wx', 0o600)).close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return;
    // A breaker killed mid-turn leaves its marker; a live one holds it for
    // milliseconds.
    const age = await stat(breaking).then((info) => Date.now() - info.mtimeMs).catch(() => undefined);
    if (age !== undefined && age > LOCK_TUNING.staleMs) await unlink(breaking).catch(() => undefined);
    return;
  }
  try {
    const judged = await stat(lockPath).catch(() => undefined);
    const current = await readFile(lockPath, 'utf8').catch(() => undefined);
    if (!judged || current !== observedRaw) return;
    if (stillStale && !await stillStale(current)) return;
    const aside = `${lockPath}.${process.pid}.${randomBytes(6).toString('hex')}.stale`;
    try {
      await rename(lockPath, aside);
    } catch {
      return; // Released meanwhile.
    }
    const taken = await stat(aside).catch(() => undefined);
    if (!taken || taken.ino !== judged.ino) await link(aside, lockPath).catch(() => undefined);
    await unlink(aside).catch(() => undefined);
  } finally {
    await unlink(breaking).catch(() => undefined);
  }
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
  const result = queueTurn(lockPath, previous).then(() => holdFileLock(lockPath, run));
  const settled = result.catch(() => undefined);
  lockQueues.set(lockPath, settled);
  void settled.then(() => { if (lockQueues.get(lockPath) === settled) lockQueues.delete(lockPath); });
  return result;
}

/** Waits for this process's earlier holder of `lockPath` -- for as long as
 * one may legitimately wait for the file and then hold it -- then fails the
 * same loud way a cross-process wait does. Waiting forever on a holder stuck
 * in this process left every write behind it hanging with no error. */
function queueTurn(lockPath: string, previous: Promise<unknown>): Promise<void> {
  const limit = LOCK_TUNING.waitMs + LOCK_TUNING.maxHoldMs;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new StateLockTimeoutError(lockPath, `this process (pid ${process.pid})`, limit)), limit);
    timer.unref?.();
    void previous.then(() => { clearTimeout(timer); resolve(); });
  });
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

/** Creates `lockPath` holding `mine`, or returns false if it exists. The
 * owner is written to a private temp file first and linked into place, so
 * the lock never exists without its owner: a process killed between
 * creating and writing it (open 'wx', then write) left an empty lock that
 * nobody could judge. Written per attempt, not once per wait: a link shares
 * the temp file's mtime, and a temp written before a long wait would make
 * the new lock look stale on arrival. */
async function createLock(lockPath: string, mine: string): Promise<boolean> {
  const temp = `${lockPath}.${process.pid}.${randomBytes(6).toString('hex')}.new`;
  await writeFile(temp, mine, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    await link(temp, lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

async function holdFileLock<T>(lockPath: string, run: () => Promise<T>): Promise<T> {
  await ensurePrivateDirectory(dirname(lockPath));
  const pidns = pidNamespace();
  const owner: LockOwner = { pid: process.pid, host: hostname(), nonce: randomBytes(12).toString('hex'), at: new Date().toISOString(), ...(pidns ? { pidns } : {}) };
  const mine = JSON.stringify(owner);
  const started = Date.now();
  let holder: string | undefined;
  for (;;) {
    if (await createLock(lockPath, mine)) break;
    const raw = await readFile(lockPath, 'utf8').catch(() => undefined);
    if (raw !== undefined) {
      const other = parseLockOwner(raw);
      holder = other ? `pid ${other.pid} on ${other.host}` : undefined;
      if (await lockLooksStale(lockPath, raw)) {
        await breakStaleLock(lockPath, raw, (current) => lockLooksStale(lockPath, current));
        continue;
      }
    }
    const waited = Date.now() - started;
    // Proceeding without the lock would make the read-merge-write below
    // non-atomic and silently drop another terminal's work. Refuse instead.
    if (waited > LOCK_TUNING.waitMs) throw new StateLockTimeoutError(lockPath, holder, waited);
    await new Promise((resolve) => setTimeout(resolve, 8 + Math.floor(Math.random() * 12)));
  }
  // A wait anyone would notice is recorded with whoever held it: a send in
  // VS Code once stood 30 s with nothing saying what it waited for.
  const waitedMs = Date.now() - started;
  if (waitedMs >= 1_000) lifecycle('lock.wait', { lock: basename(lockPath), ms: waitedMs, ...(holder ? { holder } : {}) });
  // The heartbeat: a held lock's file stays fresh, so other processes judge
  // it by age alone (lockLooksStale) -- up to maxHoldMs.
  const heldSince = Date.now();
  const heartbeat = setInterval(() => {
    if (Date.now() - heldSince > LOCK_TUNING.maxHoldMs) { clearInterval(heartbeat); return; }
    void readFile(lockPath, 'utf8').then((current) => {
      if (current !== mine) { clearInterval(heartbeat); return undefined; }
      const now = new Date();
      return utimes(lockPath, now, now);
    }).catch(() => undefined);
  }, LOCK_TUNING.heartbeatMs);
  heartbeat.unref();
  try {
    return await run();
  } finally {
    clearInterval(heartbeat);
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
 * (transcript writes) take it as a parameter, so holding the lock
 * is checked by the compiler and nothing ever re-takes it. */
export type StateLockHeld = { readonly [stateLockBrand]: true };
const STATE_LOCK_HELD = Object.freeze({}) as StateLockHeld;

/** The one lock every index and transcript write runs under. */
export function withStateLock<T>(run: (held: StateLockHeld) => Promise<T>): Promise<T> {
  return withFileLock(stateLockPath(), () => run(STATE_LOCK_HELD));
}
