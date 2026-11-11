/** Where a session's worker lives, and whether it is actually still there.
 *
 * One worker per session, on demand, not a shared daemon: turn execution
 * already assumes one live vendor child and one checkpoint stream per
 * session (see turn/vendor-process.ts's persistentTransportFor and turn/turn-journal.ts's DurableTurnCheckpoint),
 * so a worker holding exactly one session's slice of HarnessState makes that
 * assumption explicit instead of coordinated by convention. It also means a
 * worker can crash without taking any other open conversation down with it.
 */
import { quiet } from '../runtime/lifecycle-log.js';
import { createHash, randomBytes } from 'node:crypto';
import { statSync, watch } from 'node:fs';
import { link, mkdir, readdir, readFile, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFile } from '../session/store/files.js';
import { breakStaleLock, pidIsAlive } from '../session/store/locks.js';
import { stateDirectory } from '../session/store/paths.js';

import type { BackgroundCommand } from '../harness/protocol/background-agents.js';

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
  /** An approval the running turn is waiting on, oldest first. Rewritten as
   * it changes, so a conversation list or another agent can tell a turn
   * that is working from one that is waiting on the user. */
  awaitingApproval?: { title: string; since: string };
  /** What the vendor still runs for this conversation -- agents, workflows, terminals -- while
   * no turn of its own is generating (or beside one). Rewritten as it changes, so a conversation
   * list keeps the chat among the working ones until that work is done. */
  background?: { agents?: number; terminals?: number; workflows?: number; since: string; /** The terminals' commands by pid, when they could be read. */ commands?: BackgroundCommand[] };
  /** A user or vendor-background turn currently executing in this worker. The transcript journal can
   * outlive a failed/abandoned request; this is the authoritative live state. */
  runningTurn?: { since: string };
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

/** What a worker being started writes to stderr, read by the window that started it when the
 * worker does not come up (client.ts): the reason it died at startup, not just that it did. */
export function workerStartLogPath(sessionId: string): string {
  return join(workersDirectory(), `${sessionKey(sessionId)}.start.log`);
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

/** The temp directory this process started with. A worker re-points TMPDIR at
 * a directory inside the state directory for everything its agent runs
 * (conversation-tmp.ts); a socket falls back here only because the state
 * directory's own path is too long, and a fallback inside that directory is
 * longer still. Read once, at import, so the path every process derives for a
 * session is the same one. */
const STARTUP_TMPDIR = tmpdir();

/** Windows has no Unix domain sockets on a path a client can find by name the
 * way every other platform does: a worker listens on a named pipe instead,
 * which `net` treats identically. Pipe names share one machine-wide namespace,
 * so the state directory is part of the name -- two users, or a portable
 * CLIKCODE_HOME beside the default one, never meet on the same pipe. */
export function socketPathFor(sessionId: string, platform: NodeJS.Platform = process.platform): string {
  return socketPathForKey(sessionKey(sessionId), platform);
}

function socketPathForKey(key: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const scope = createHash('sha256').update(stateDirectory()).digest('hex').slice(0, 12);
    return `\\\\.\\pipe\\clikcode-${scope}-${key}`;
  }
  const standard = join(workersDirectory(), `${key}.sock`);
  if (standard.length < 100) return standard;
  return join(STARTUP_TMPDIR, `cc-${key}.sock`);
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

/** `existing`: only rewrite a record that is there -- never recreate the
 * directory, which would bring back a state home that was deleted.
 *
 * Not fsynced (atomicWriteFile durable: false): a record describes a live
 * process and means nothing after a power loss, which ends that process too;
 * readers still never see a torn one. Two fsyncs per rewrite, on every turn
 * edge and background change of every worker, were disk waits for nothing. */
export async function writeWorkerRecord(record: WorkerRuntimeRecord, options: { existing?: boolean } = {}): Promise<void> {
  if (options.existing && !await stat(recordPath(record.sessionId)).then(() => true, () => false)) return;
  await atomicWriteFile(recordPath(record.sessionId), `${JSON.stringify(record, null, 2)}\n`, { durable: false });
}

/** When a record was last written: its worker started, a turn started or
 * ended, an approval or background work came or went -- when it was last
 * used, without a write of its own for that. */
export async function workerRecordWrittenAt(sessionId: string): Promise<number | undefined> {
  return stat(recordPath(sessionId)).then((info) => info.mtimeMs, () => undefined);
}

/** How many worker records there are, from one directory read (no record read). */
export async function workerRecordCount(): Promise<number> {
  return (await readdir(workersDirectory()).catch(() => [] as string[])).filter((name) => name.endsWith('.json')).length;
}

export function generateWorkerToken(): string {
  return randomBytes(16).toString('hex');
}

/** Removes the record only while it is still `token`'s: a worker shutting
 * down must never delete the record of the worker that replaced it. */
export async function removeWorkerRecord(sessionId: string, token: string): Promise<void> {
  if ((await readWorkerRecord(sessionId).catch(quiet('worker/registry')))?.token !== token) return;
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
 * suspended laptop stalls every timer at once).
 *
 * `client` is presence, not execution: a terminal or editor chat showing the
 * conversation before (or without) any worker. It is the same record under
 * the same liveness rule, in its own `.open` file so it never competes with
 * the worker for `.owner`. It is bookkeeping -- a second window may still
 * open the chat -- and answers "is someone else showing this" for lists and
 * for the sweeps that must not drop a chat in use. */
type ConversationOwnerKind = 'worker' | 'turn' | 'client';

interface ConversationOwner {
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

function ownerPath(sessionId: string, kind: ConversationOwnerKind = 'worker'): string {
  return join(workersDirectory(), `${sessionKey(sessionId)}.${kind === 'client' ? 'open' : 'owner'}`);
}

function handoffPath(sessionId: string): string {
  return join(workersDirectory(), `${sessionKey(sessionId)}.handoff`);
}

interface HandoffRequest { toHost: string; at: number }
const HANDOFF_FRESH_MS = 60_000;
export const CONVERSATION_HANDOFF_REASON = 'conversation moved to another machine';

/** A client chose a different machine. Ask the worker holding the shared
 * conversation to finish its current work and release it. A Unix socket
 * cannot be contacted across hosts. */
export async function requestConversationHandoff(sessionId: string): Promise<boolean> {
  const owner = await conversationHolder(sessionId);
  if (!owner || owner.kind !== 'worker' || owner.host === hostname()) return false;
  await atomicWriteFile(handoffPath(sessionId), `${JSON.stringify({ toHost: hostname(), at: Date.now() } satisfies HandoffRequest)}\n`, { durable: false });
  return true;
}

/** The worker on the machine being left honors a recent request. The
 * destination's worker ignores the same file after it takes the lease. */
export async function conversationHandoffRequested(sessionId: string, workerHost: string = hostname()): Promise<boolean> {
  const raw = await readFile(handoffPath(sessionId), 'utf8').catch(quiet('worker/registry'));
  if (!raw) return false;
  try {
    const request = JSON.parse(raw) as Partial<HandoffRequest>;
    return typeof request.toHost === 'string' && request.toHost !== workerHost
      && typeof request.at === 'number' && Date.now() - request.at < HANDOFF_FRESH_MS;
  } catch { return false; }
}

/** Calls `changed` when this conversation's handoff file is written, where
 * the filesystem reports it (not every shared filesystem does: the caller
 * also looks on a timer). The directory is watched: the file is not there
 * until a request writes it. Returns what stops the watch. */
export function watchHandoffRequest(sessionId: string, changed: () => void): () => void {
  const name = `${sessionKey(sessionId)}.handoff`;
  try {
    const watcher = watch(workersDirectory(), { persistent: false }, (_event, file) => {
      if (file === null || String(file) === name) changed();
    });
    watcher.on('error', () => watcher.close());
    return () => watcher.close();
  } catch {
    // fail-open-ok: no watch here; the caller's timer still sees the request
    return () => undefined;
  }
}

function parseOwner(raw: string): ConversationOwner | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<ConversationOwner>;
    return typeof parsed.pid === 'number' && typeof parsed.host === 'string' && (parsed.kind === 'worker' || parsed.kind === 'turn' || parsed.kind === 'client')
      ? parsed as ConversationOwner : undefined;
  } catch {
    // fail-open-ok: an unreadable owner file identifies no one; age alone condemns it
    return undefined;
  }
}

async function ownerIsLive(sessionId: string, owner: ConversationOwner | undefined, path = ownerPath(sessionId), socketPath = socketPathFor(sessionId)): Promise<boolean> {
  const modified = await stat(path).then((info) => info.mtimeMs, () => undefined);
  if (modified === undefined) return false;
  const fresh = Date.now() - modified < OWNER_STALE_MS;
  // A holder between create and write, or another machine's (a shared
  // home): only its age can be judged.
  if (!owner || owner.host !== hostname()) return fresh;
  if (!pidIsAlive(owner.pid)) return false;
  if (fresh) return true;
  return owner.kind === 'worker' && workerIsReachable(socketPath);
}

/** Whether the worker a record names is still running: the one liveness rule
 * for worker records. The record is a note the worker leaves; the lease
 * (`.owner`) is what it keeps fresh while it lives (refreshed every 10 s,
 * stale after 60 s, kept by a suspended worker that still answers). A record
 * is alive only while the lease is a worker's and names the record's pid --
 * a pid check on its own counted a recycled pid (or anyone's, via EPERM) as
 * the worker, so a chat killed by the stuck watchdog showed "working" for ever. */
export async function workerAlive(record: Pick<WorkerRuntimeRecord, 'pid' | 'sessionId'>): Promise<boolean> {
  const path = ownerPath(record.sessionId);
  const raw = await readFile(path, 'utf8').catch(quiet('worker/registry'));
  const owner = raw === undefined ? undefined : parseOwner(raw);
  if (!owner || owner.kind !== 'worker' || owner.pid !== record.pid) return false;
  return ownerIsLive(record.sessionId, owner, path);
}

/** The worker records whose worker is alive (workerAlive). A record that
 * fails the check is removed -- only while it is still the record judged, so
 * one a new worker just wrote is never taken. */
export async function liveWorkerRecords(): Promise<WorkerRuntimeRecord[]> {
  const records = await listWorkerRecords();
  const alive = await Promise.all(records.map(async (record) => {
    if (await workerAlive(record)) return true;
    await removeDeadWorkerRecord(record).catch(quiet('worker/registry'));
    return false;
  }));
  return records.filter((_, index) => alive[index]);
}

/** Removes a record whose worker is gone, re-judged under breakStaleLock's
 * turn-taking so a record rewritten meanwhile (a new worker's) stays. */
export async function removeDeadWorkerRecord(record: WorkerRuntimeRecord): Promise<void> {
  const path = recordPath(record.sessionId);
  const raw = await readFile(path, 'utf8').catch(quiet('worker/registry'));
  if (raw === undefined) return;
  const sameRecord = (current: string): boolean => {
    try {
      const parsed = JSON.parse(current) as Partial<WorkerRuntimeRecord>;
      return parsed.token === record.token && parsed.pid === record.pid;
    } catch { return false; }
  };
  if (!sameRecord(raw)) return;
  await breakStaleLock(path, raw, async (current) => sameRecord(current) && !await workerAlive(record));
}

/** A temp a killed writer left (a staged lease, an atomic write's temp, a
 * breaker's marker or set-aside copy), or a start log nobody reads: a live
 * one exists for milliseconds, a start log for the seconds a worker takes to
 * come up. */
const WORKER_LEFTOVER_MS = 60_000;
const START_LOG_MAX_AGE_MS = 10 * 60_000;

/** What the workers directory keeps of workers that are gone: records whose
 * worker is not alive, handoff requests past their freshness, leases and
 * presence files nobody refreshes, sockets nothing listens on, and temps and
 * start logs a killed process left. Everything else -- a live worker's
 * record, lease, socket -- stays. Returns how many entries went. */
export async function sweepWorkersDirectory(now = Date.now()): Promise<number> {
  const directory = workersDirectory();
  const names = await readdir(directory).catch(() => [] as string[]);
  let removed = 0;
  const ageOf = (path: string): Promise<number | undefined> => stat(path).then((info) => now - info.mtimeMs, () => undefined);
  const remove = async (path: string): Promise<void> => {
    await unlink(path).then(() => { removed += 1; }, quiet('worker/registry'));
  };
  const before = (await listWorkerRecords()).length;
  const live = await liveWorkerRecords();
  removed += before - live.length;
  const liveSockets = new Set(live.map((record) => record.socketPath));
  for (const name of names) {
    const path = join(directory, name);
    if (/\.(new|tmp|stale|breaking)$/.test(name)) {
      const age = await ageOf(path);
      if (age !== undefined && age > WORKER_LEFTOVER_MS) await remove(path);
    } else if (name.endsWith('.handoff')) {
      const age = await ageOf(path);
      if (age !== undefined && age > HANDOFF_FRESH_MS) await remove(path);
    } else if (name.endsWith('.start.log')) {
      const age = await ageOf(path);
      if (age !== undefined && age > START_LOG_MAX_AGE_MS) await remove(path);
    } else if (name.endsWith('.owner') || name.endsWith('.open')) {
      const raw = await readFile(path, 'utf8').catch(quiet('worker/registry'));
      if (raw === undefined) continue;
      const age = await ageOf(path);
      const socket = socketPathForKey(name.slice(0, name.lastIndexOf('.')));
      if (age === undefined || age < OWNER_STALE_MS || await ownerIsLive('', parseOwner(raw), path, socket)) continue;
      // Re-judged in breakStaleLock's turn: a holder that refreshed or replaced it meanwhile keeps it.
      await breakStaleLock(path, raw, async (current) => !await ownerIsLive('', parseOwner(current), path, socket));
      if (!await stat(path).then(() => true, () => false)) removed += 1;
    } else if (name.endsWith('.sock') && !liveSockets.has(path)) {
      const age = await ageOf(path);
      if (age !== undefined && age > WORKER_LEFTOVER_MS && !await workerIsReachable(path, 200)) await remove(path);
    }
  }
  return removed;
}

/** Who runs the conversation's turns now, if anyone does. */
export async function conversationHolder(sessionId: string): Promise<ConversationOwner | undefined> {
  const raw = await readFile(ownerPath(sessionId), 'utf8').catch(quiet('worker/registry'));
  const owner = raw === undefined ? undefined : parseOwner(raw);
  return owner && await ownerIsLive(sessionId, owner) ? owner : undefined;
}

/** The conversation for this process, or who holds it now. */
export async function takeConversation(
  sessionId: string, kind: ConversationOwnerKind,
): Promise<{ hold: ConversationHold } | { holder: ConversationOwner }> {
  await ensureWorkersDirectory();
  const path = ownerPath(sessionId, kind);
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
      await unlink(staging).catch(quiet('worker/registry'));
    }
    const raw = await readFile(path, 'utf8').catch(quiet('worker/registry'));
    if (raw === undefined) continue; // Released between the two calls.
    const holder = parseOwner(raw);
    if (holder && await ownerIsLive(sessionId, holder, path)) return { holder };
    if (!holder && await ownerIsLive(sessionId, undefined, path)) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      continue;
    }
    await breakStaleLock(path, raw);
  }
  throw new Error(`Could not settle who runs conversation ${sessionId}.`);
}

/** Which conversations another process has open (presence records, judged by
 * the owner liveness rule), from one directory read. This process's own
 * records do not count: it asks who ELSE is showing a chat. */
export async function liveOpenConversations(): Promise<(sessionId: string) => boolean> {
  const keys = new Set<string>();
  const names = await readdir(workersDirectory()).catch(() => [] as string[]);
  await Promise.all(names.filter((name) => name.endsWith('.open')).map(async (name) => {
    const path = join(workersDirectory(), name);
    const raw = await readFile(path, 'utf8').catch(quiet('worker/registry'));
    const owner = raw === undefined ? undefined : parseOwner(raw);
    if (!owner || (owner.pid === process.pid && owner.host === hostname())) return;
    if (await ownerIsLive('', owner, path)) keys.add(name.slice(0, -'.open'.length));
  }));
  return (sessionId) => keys.has(sessionKey(sessionId));
}

function holdOf(path: string, mine: string): ConversationHold {
  const held = async (): Promise<boolean> => (await readFile(path, 'utf8').catch(quiet('worker/registry'))) === mine;
  const refresh = setInterval(() => {
    void held().then((still) => {
      if (!still) { clearInterval(refresh); return undefined; }
      const now = new Date();
      return utimes(path, now, now);
    }).catch(quiet('worker/registry'));
  }, OWNER_REFRESH_MS);
  refresh.unref();
  return {
    held,
    release: async () => {
      clearInterval(refresh);
      if (await held()) await unlink(path).catch(quiet('worker/registry'));
    },
  };
}

/** The only liveness question that matters: can a connection actually be
 * opened. Not a PID check -- a PID can be reused by an unrelated process the
 * instant the real worker exits, and the claim files this registry replaced existed almost entirely to paper over exactly that kind of
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
