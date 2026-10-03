/** Where a session's worker lives, and whether it is actually still there.
 *
 * One worker per session, on demand, not a shared daemon: turn execution
 * already assumes one live vendor child and one checkpoint stream per
 * session (see turn/vendor-process.ts's persistentTransportFor and turn/turn-journal.ts's DurableTurnCheckpoint),
 * so a worker holding exactly one session's slice of HarnessState makes that
 * assumption explicit instead of coordinated by convention. It also means a
 * worker can crash without taking any other open conversation down with it.
 */
import { createHash, randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { link, mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { breakStaleLock, pidIsAlive } from '../session/store/locks.js';
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

export function workersDirectory(): string {
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
function sessionKey(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 20);
}

function socketFileName(sessionId: string): string {
  return `${sessionKey(sessionId)}.sock`;
}

function recordPath(sessionId: string): string {
  return join(workersDirectory(), `${sessionKey(sessionId)}.json`);
}

/** Must run before anything binds a UDS under this directory -- `listen()`
 * on a path whose parent does not exist fails with an 'error' event, not a
 * thrown rejection a caller forgetting to await would notice; a socket that
 * silently never came up is much harder to debug than mkdir running once
 * more than strictly needed. */
export async function ensureWorkersDirectory(): Promise<void> {
  await mkdir(workersDirectory(), { recursive: true, mode: 0o700 });
}

/** Windows has no Unix domain sockets on a path a client can find by name the
 * way every other platform does: a worker listens on a named pipe instead,
 * which `net` treats identically. Pipe names share one machine-wide namespace,
 * so the state directory is part of the name -- two users, or a portable
 * CLIKCODE_HOME beside the default one, never meet on the same pipe. */
export function socketPathFor(sessionId: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const scope = createHash('sha256').update(stateDirectory()).digest('hex').slice(0, 12);
    return `\\\\.\\pipe\\clikcode-${scope}-${socketFileName(sessionId).replace(/\.sock$/, '')}`;
  }
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

/** Every worker record on disk. Used to ask stale-build workers to step down
 * without waiting for each conversation to be reopened (Left on the board,
 * or a rebuild while this window is open). Owner files and sockets are not
 * records. */
export async function listWorkerRecords(): Promise<WorkerRuntimeRecord[]> {
  let names: string[];
  try {
    names = await readdir(workersDirectory());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records: WorkerRuntimeRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(workersDirectory(), name), 'utf8');
      const parsed = JSON.parse(raw) as Partial<WorkerRuntimeRecord>;
      if (typeof parsed.pid !== 'number' || typeof parsed.socketPath !== 'string' || typeof parsed.token !== 'string' || typeof parsed.sessionId !== 'string') continue;
      records.push(parsed as WorkerRuntimeRecord);
    } catch {
      // fail-open-ok: a corrupt record is skipped; the next spawn overwrites it
    }
  }
  return records;
}

export async function writeWorkerRecord(record: WorkerRuntimeRecord): Promise<void> {
  await mkdir(workersDirectory(), { recursive: true, mode: 0o700 });
  const target = recordPath(record.sessionId);
  const temporary = `${target}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export function generateWorkerToken(): string {
  return randomBytes(16).toString('hex');
}

/** Removes the record only while it is still `token`'s: a worker shutting
 * down must never delete the record of the worker that replaced it. */
export async function removeWorkerRecord(sessionId: string, token: string): Promise<void> {
  if ((await readWorkerRecord(sessionId).catch(() => undefined))?.token !== token) return;
  await unlink(recordPath(sessionId)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

/** Who runs a conversation's turns: its worker, for as long as it lives, or
 * -- with no worker reachable -- a process running one turn in-process (a
 * scripted `clikcode send`). Exactly one at a time.
 *
 * Without this two workers could serve one conversation: two windows that
 * both found none spawned one each, and the second unlinked the first's
 * socket and bound its own, leaving the first running turns nobody could
 * reach. And a scripted send running in-process let a worker start mid-turn,
 * and the two journals' last full-file writer won.
 *
 * Taken by an exclusive create (a staged file hard-linked into place, so it
 * appears complete or not at all), refreshed while held, released only by
 * its owner. A holder is gone when its pid is, or when it stopped refreshing
 * -- pids get reused -- except a worker that still answers on its socket (a
 * suspended laptop stalls every timer at once). */
export type ConversationOwnerKind = 'worker' | 'turn';

export interface ConversationOwner {
  pid: number;
  host: string;
  kind: ConversationOwnerKind;
  nonce: string;
  at: string;
}

export interface ConversationHold {
  /** Still this process's: it was not judged stale and taken over. */
  held(): Promise<boolean>;
  release(): Promise<void>;
}

const OWNER_REFRESH_MS = 10_000;
const OWNER_STALE_MS = 60_000;

function ownerPath(sessionId: string): string {
  return join(workersDirectory(), `${sessionKey(sessionId)}.owner`);
}

function parseOwner(raw: string): ConversationOwner | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<ConversationOwner>;
    return typeof parsed.pid === 'number' && typeof parsed.host === 'string' && (parsed.kind === 'worker' || parsed.kind === 'turn')
      ? parsed as ConversationOwner : undefined;
  } catch {
    // fail-open-ok: an unreadable owner file identifies no one; age alone condemns it
    return undefined;
  }
}

async function ownerIsLive(sessionId: string, owner: ConversationOwner | undefined): Promise<boolean> {
  const modified = await stat(ownerPath(sessionId)).then((info) => info.mtimeMs, () => undefined);
  if (modified === undefined) return false;
  const fresh = Date.now() - modified < OWNER_STALE_MS;
  // A holder between create and write, or another machine's (a shared
  // home): only its age can be judged.
  if (!owner || owner.host !== hostname()) return fresh;
  if (!pidIsAlive(owner.pid)) return false;
  if (fresh) return true;
  return owner.kind === 'worker' && workerIsReachable(socketPathFor(sessionId));
}

/** Who runs the conversation's turns now, if anyone does. */
export async function conversationHolder(sessionId: string): Promise<ConversationOwner | undefined> {
  const raw = await readFile(ownerPath(sessionId), 'utf8').catch(() => undefined);
  const owner = raw === undefined ? undefined : parseOwner(raw);
  return owner && await ownerIsLive(sessionId, owner) ? owner : undefined;
}

/** The conversation for this process, or who holds it now. */
export async function takeConversation(
  sessionId: string, kind: ConversationOwnerKind,
): Promise<{ hold: ConversationHold } | { holder: ConversationOwner }> {
  await ensureWorkersDirectory();
  const path = ownerPath(sessionId);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const owner: ConversationOwner = { pid: process.pid, host: hostname(), kind, nonce: randomBytes(9).toString('hex'), at: new Date().toISOString() };
    const mine = JSON.stringify(owner);
    const staging = `${path}.${process.pid}.${owner.nonce}.new`;
    await writeFile(staging, mine, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      await link(staging, path);
      return { hold: holdOf(path, mine) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      await unlink(staging).catch(() => undefined);
    }
    const raw = await readFile(path, 'utf8').catch(() => undefined);
    if (raw === undefined) continue; // Released between the two calls.
    const holder = parseOwner(raw);
    if (holder && await ownerIsLive(sessionId, holder)) return { holder };
    if (!holder && await ownerIsLive(sessionId, undefined)) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      continue;
    }
    await breakStaleLock(path, raw);
  }
  throw new Error(`Could not settle who runs conversation ${sessionId}.`);
}

function holdOf(path: string, mine: string): ConversationHold {
  const held = async (): Promise<boolean> => (await readFile(path, 'utf8').catch(() => undefined)) === mine;
  const refresh = setInterval(() => {
    void held().then((still) => {
      if (!still) { clearInterval(refresh); return undefined; }
      const now = new Date();
      return utimes(path, now, now);
    }).catch(() => undefined);
  }, OWNER_REFRESH_MS);
  refresh.unref();
  return {
    held,
    release: async () => {
      clearInterval(refresh);
      if (await held()) await unlink(path).catch(() => undefined);
    },
  };
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
