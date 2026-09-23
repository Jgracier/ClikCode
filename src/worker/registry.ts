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
import { statSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stateDirectory } from '../session/store/paths.js';

export interface WorkerRuntimeRecord {
  pid: number;
  sessionId: string;
  socketPath: string;
  installationId: string;
  startedAt: string;
  /** The code this worker loaded. A worker reads dist/index.js once, at
   * spawn, and then survives 30 idle minutes and any number of client
   * restarts -- so reinstalling ClikCode and reopening the TUI left a client
   * on the new build talking to a worker still running the old one, and every
   * fix looked like it had not worked. This has caused three separate
   * misdiagnoses (of the response duplication, of the failover wording, and
   * of a vanishing message), which is what makes it worth recording rather
   * than remembering. Absent on a record written before this existed, which
   * reads as "not this build" -- correctly, since it cannot be known to be. */
  build?: string;
  /** Random per-worker, checked on connect so a stale socket path recycled by
   * an unrelated later process (same pid reused by the OS, or a filesystem
   * left the path behind after an unclean exit) is never mistaken for this
   * session's own worker. */
  token: string;
}

/** What identifies a build: the entry file a worker actually loads, by
 * modification time and size.
 *
 * Not the version string -- the whole problem is two processes running
 * different code with the SAME version between two releases. Not a content
 * hash either: this is checked on every attach, and mtime+size answers the
 * only question being asked (is this the same file as the one I would spawn)
 * without reading three megabytes to do it.
 *
 * Both sides stat the same path deliberately: the worker's own entry IS the
 * script a client would spawn, so a test pointing CLIKCODE_WORKER_ENTRY at a
 * real build still compares like with like. Undefined when the entry cannot
 * be stat'd at all, and an unknown build never retires anything. */
export function currentWorkerBuild(): string | undefined {
  const entry = process.env.CLIKCODE_WORKER_ENTRY ?? process.argv[1];
  if (!entry) return undefined;
  try {
    const stats = statSync(entry);
    return `${Math.round(stats.mtimeMs)}:${stats.size}`;
  } catch {
    return undefined;
  }
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
  const standard = join(workersDirectory(), socketFileName(sessionId));
  if (standard.length < 100) return standard;
  return join(tmpdir(), `cc-${socketFileName(sessionId)}`);
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
