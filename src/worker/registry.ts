/** Where a session's worker lives, and whether it is actually still there.
 *
 * One worker per session, on demand, not a shared daemon: turn execution
 * already assumes one live vendor child and one checkpoint stream per
 * session (see turn/runtime.ts's persistentTransportFor/DurableTurnCheckpoint),
 * so a worker holding exactly one session's slice of HarnessState makes that
 * assumption explicit instead of coordinated by convention. It also means a
 * worker can crash without taking any other open conversation down with it.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { stateDirectory } from '../session/store/paths.js';

export interface WorkerRuntimeRecord {
  pid: number;
  sessionId: string;
  socketPath: string;
  installationId: string;
  startedAt: string;
  /** Random per-worker, checked on connect so a stale socket path recycled by
   * an unrelated later process (same pid reused by the OS, or a filesystem
   * left the path behind after an unclean exit) is never mistaken for this
   * session's own worker. */
  token: string;
}

function workersDirectory(): string {
  return join(stateDirectory(), 'workers');
}

/** A UDS path has a real length ceiling (108 bytes on Linux, 104 on
 * macOS/BSD) that a session id -- a 36-character UUID, under a home
 * directory of arbitrary depth -- can plausibly blow past. Truncated to 20
 * hex characters: short enough to leave headroom under any reasonable home
 * path, long enough that two sessions colliding is not a real risk (a
 * collision here just means one worker's socket briefly looks reachable
 * under the other's path, caught immediately by the token check on connect,
 * not a security boundary). */
function socketFileName(sessionId: string): string {
  return `${createHash('sha256').update(sessionId).digest('hex').slice(0, 20)}.sock`;
}

function recordPath(sessionId: string): string {
  return join(workersDirectory(), `${createHash('sha256').update(sessionId).digest('hex').slice(0, 20)}.json`);
}

/** Must run before anything binds a UDS under this directory -- `listen()`
 * on a path whose parent does not exist fails with an 'error' event, not a
 * thrown rejection a caller forgetting to await would notice; a socket that
 * silently never came up is much harder to debug than mkdir running once
 * more than strictly needed. */
export async function ensureWorkersDirectory(): Promise<void> {
  await mkdir(workersDirectory(), { recursive: true, mode: 0o700 });
}

export function socketPathFor(sessionId: string): string {
  return join(workersDirectory(), socketFileName(sessionId));
}

export async function readWorkerRecord(sessionId: string): Promise<WorkerRuntimeRecord | undefined> {
  try {
    const raw = await readFile(recordPath(sessionId), 'utf8');
    const parsed = JSON.parse(raw) as Partial<WorkerRuntimeRecord>;
    if (typeof parsed.pid !== 'number' || typeof parsed.socketPath !== 'string' || typeof parsed.token !== 'string') return undefined;
    return parsed as WorkerRuntimeRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function writeWorkerRecord(record: WorkerRuntimeRecord): Promise<void> {
  await mkdir(workersDirectory(), { recursive: true, mode: 0o700 });
  await writeFile(recordPath(record.sessionId), `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function generateWorkerToken(): string {
  return randomBytes(16).toString('hex');
}

export async function removeWorkerRecord(sessionId: string): Promise<void> {
  await unlink(recordPath(sessionId)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

/** The only liveness question that matters: can a connection actually be
 * opened. Not a PID check -- a PID can be reused by an unrelated process the
 * instant the real worker exits, and claim.ts/claims.ts (the machinery this
 * replaces) existed almost entirely to paper over exactly that kind of
 * false positive with host comparisons and heartbeat TTLs. A socket that
 * accepts a connection IS the worker; one that refuses or does not exist
 * is not, with nothing in between to get wrong. */
export function workerIsReachable(socketPath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolveReachable) => {
    const socket = connect(socketPath);
    const settle = (reachable: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolveReachable(reachable);
    };
    const timer = setTimeout(() => settle(false), timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); settle(true); });
    socket.once('error', () => { clearTimeout(timer); settle(false); });
  });
}
