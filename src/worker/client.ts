/** Finding, spawning, and talking to a session's worker from a terminal
 * client. The client never cares whether the worker it ends up talking to
 * was already running or was just started -- attach() answers the same way
 * either way, which is the whole point: a reconnect is never a special case
 * (see reseedTranscript in tui/prompter.ts for what that used to cost).
 */
import { lifecycle } from '../runtime/lifecycle-log.js';
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { userManagerLaunch } from './own-scope.js';
import { EventEmitter } from 'node:events';
import { connect, type Socket } from 'node:net';
import { hostname } from 'node:os';
import { conversationHolder, currentWorkerBuild, listWorkerRecords, readWorkerRecord, requestConversationHandoff, workerIsReachable, workersDirectory, workerStartLogPath, type WorkerRuntimeRecord } from './registry.js';
import { failureText } from '../harness/protocol/stderr-line.js';
import { processAlive } from '../harness/transport/process-group.js';
import { ensureSessionOnDisk } from '../session/blank.js';
import { encodeFrame, FrameDecoder, type ClientCommand, type WorkerEvent } from './protocol.js';
import { withSavedConversation } from './saved-conversation.js';

const SPAWN_TIMEOUT_MS = 5_000;
const HANDOFF_START_TIMEOUT_MS = 30_000;
/** A new worker is looked for this often: the first message of a
 * conversation waits on it, and a look is one small file read. At 50 ms the
 * wait past the moment the worker was listening averaged 25 ms. */
const SPAWN_POLL_MS = 10;

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/** The real spawn target: the same binary currently running, invoked with
 * clikcode's own hidden `session-worker <id>` subcommand (cli/register.ts)
 * -- portable to wherever this install actually lives, and the identical
 * argv shape either way. CLIKCODE_WORKER_ENTRY overrides only WHICH script
 * that is, for the one context where `process.argv[1]` is not a runnable
 * clikcode entry at all: a test runner's own process.argv[1] is vitest's,
 * not clikcode's, so tests point this at a real built dist/index.js instead
 * (this repo's `.js`-suffixed source imports do not resolve against sibling
 * `.ts` files under plain `node file.ts` -- only a real build produces
 * something directly runnable, so a raw-source entry point is not an option
 * here the way it might be in a project that runs TypeScript unbuilt). */
function workerSpawnArgv(sessionId: string, extra: readonly string[] = []): string[] {
  const entry = process.env.CLIKCODE_WORKER_ENTRY ?? process.argv[1]!;
  return [entry, 'session-worker', sessionId, ...extra];
}

/** Starts the worker process, detached. From outside the user's systemd
 * manager (an SSH session) the user manager starts it, so it lands in the
 * agent slice like every other worker (own-scope.ts userManagerLaunch); if
 * that cannot be done, it is started directly, as everywhere else. */
function launchWorker(sessionId: string, extra: readonly string[] = []): void {
  const argv = workerSpawnArgv(sessionId, extra);
  let started = false;
  // Its stderr goes to a file of the conversation's, so a worker that dies at startup says why
  // (spawnSessionWorker reads it); it is removed once the worker is up.
  const startLog = workerStartLogPath(sessionId);
  try { mkdirSync(workersDirectory(), { recursive: true, mode: 0o700 }); } catch { /* the spawn says what is wrong */ }
  const direct = (): void => {
    if (started) return;
    started = true;
    let errorFd: number | 'ignore' = 'ignore';
    try { errorFd = openSync(startLog, 'w', 0o600); } catch { /* no log: the cause is lost, not the start */ }
    const child = spawn(process.execPath, argv, {
      // windowsHide: a detached child on Windows otherwise opens a console
      // window of its own for as long as the worker lives.
      stdio: ['ignore', 'ignore', errorFd], detached: true, windowsHide: true,
    });
    if (typeof errorFd === 'number') closeSync(errorFd);
    // A process that could not even start has nothing to write: its error is the cause.
    child.on('error', (error) => { try { appendFileSync(startLog, `${error.message}\n`); } catch { /* the log below says nothing then */ } });
    child.unref();
  };
  const viaManager = process.platform === 'linux' ? userManagerLaunch(argv, {
    cgroup: (() => { try { return readFileSync('/proc/self/cgroup', 'utf8'); } catch { return ''; } })(),
    uid: process.getuid?.() ?? 0, env: process.env, cwd: process.cwd(), execPath: process.execPath,
    unit: `clikcode-start-${sessionId.replace(/[^A-Za-z0-9_.-]/g, '_')}-${process.pid}-${Date.now()}.service`,
    busExists: existsSync, stderrFile: startLog,
  }) : undefined;
  if (!viaManager) { direct(); return; }
  lifecycle('client.worker.spawn-via-user-manager', { worker: sessionId });
  const launcher = spawn(viaManager.command, viaManager.args, { env: viaManager.env, stdio: 'ignore', detached: true });
  launcher.on('error', direct);
  launcher.on('exit', (code) => { if (code !== 0) direct(); });
  launcher.unref();
}

function readStartLog(sessionId: string): string {
  try { return readFileSync(workerStartLogPath(sessionId), 'utf8'); } catch { return ''; }
}
function removeStartLog(sessionId: string): void {
  try { unlinkSync(workerStartLogPath(sessionId)); } catch { /* already gone */ }
}

/** Starts a fresh worker for a session and waits until its socket actually
 * accepts a connection -- not until the child process merely exists, which
 * would race the worker's own listen() call. */
async function spawnSessionWorker(sessionId: string): Promise<WorkerRuntimeRecord> {
  lifecycle('client.worker.spawn', { worker: sessionId });
  launchWorker(sessionId);
  let deadline = Date.now() + SPAWN_TIMEOUT_MS;
  let handoffAskedAt = 0;
  let holder: Awaited<ReturnType<typeof conversationHolder>>;
  let holderCheckedAt = 0;
  for (;;) {
    const record = await readWorkerRecord(sessionId);
    if (record && await recordIsLive(record)) { removeStartLog(sessionId); return record; }
    if (Date.now() - holderCheckedAt >= 250) {
      holder = await conversationHolder(sessionId);
      holderCheckedAt = Date.now();
    }
    // A different machine's socket cannot be attached here. Ask its worker
    // to hand over, then keep waiting for the local worker we launched. A
    // running turn finishes there first; there is no cross-host refusal.
    if (holder && holder.host !== hostname()) {
      deadline = Date.now() + HANDOFF_START_TIMEOUT_MS;
      if (holder.kind === 'worker' && Date.now() - handoffAskedAt >= 5_000) {
        await requestConversationHandoff(sessionId);
        handoffAskedAt = Date.now();
      }
    }
    // A scripted send is running a turn in-process: the worker starts when it
    // ends, and this waits for it like any turn already running.
    if (Date.now() > deadline && holder?.kind !== 'turn') {
      const cause = failureText(readStartLog(sessionId));
      removeStartLog(sessionId);
      throw new Error(`session worker for "${sessionId}" did not start in time${cause ? `:\n${cause}` : ' (it wrote nothing to say why; see "clikcode logs")'}`);
    }
    await delay(SPAWN_POLL_MS);
  }
}

/** How long to wait for a retired worker to actually let go of its socket.
 * It shuts down gracefully (session-worker.ts) -- telling its clients,
 * removing its record, unlinking the socket -- and that is fast, but it is
 * not instant and spawning a replacement onto a path still held is the one
 * way this can go wrong. */
const RETIRE_TIMEOUT_MS = 3_000;

async function socketReleased(record: WorkerRuntimeRecord): Promise<boolean> {
  const deadline = Date.now() + RETIRE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!await workerIsReachable(record.socketPath, 200)) return true;
    await delay(SPAWN_POLL_MS);
  }
  return false;
}

/** How long a worker has to answer `retire` before it is kept as it is. A
 * worker answers within milliseconds even mid-turn, and a message sent right
 * after switching waits on it. */
const RETIRE_ANSWER_MS = 500;
/** How long a window waits for a worker's first reply (its snapshot). CLIKCODE_ATTACH_ANSWER_MS shortens it for tests. */
const ATTACH_ANSWER_MS = Number(process.env.CLIKCODE_ATTACH_ANSWER_MS) > 0 ? Number(process.env.CLIKCODE_ATTACH_ANSWER_MS) : 30_000;

/** Asks a worker on another build to step down. It knows whether it is in
 * the middle of something and the asking window does not -- so it decides:
 * `retired` (it is shutting down), `declined` (busy; it goes once it is not),
 * or `unanswered` (nothing said in time, or the connection ended with nothing
 * said: what became of the worker is then looked at, not guessed).
 *
 * A question on its own: it is not an attach, so the worker neither reads the
 * conversation nor sends a snapshot of it to a window that would throw it away. */
function askToRetire(record: WorkerRuntimeRecord, reason?: 'moved'): Promise<'retired' | 'declined' | 'unanswered'> {
  return new Promise((resolveAnswer) => {
    const socket = connect(record.socketPath);
    const frames = new FrameDecoder();
    let answered = false;
    const answer = (value: 'retired' | 'declined' | 'unanswered'): void => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      socket.destroy();
      resolveAnswer(value);
    };
    const timer = setTimeout(() => answer('unanswered'), RETIRE_ANSWER_MS);
    socket.on('connect', () => {
      socket.write(encodeFrame({ type: 'retire', token: record.token, ...(reason ? { reason } : {}) } satisfies ClientCommand));
    });
    socket.on('data', (chunk) => {
      for (const message of frames.push(chunk) as WorkerEvent[]) {
        if (message.type === 'retire-declined') answer('declined');
        else if (message.type === 'attach-rejected') answer('unanswered');
        else if (message.type === 'shutdown') answer('retired');
      }
    });
    // A connection that ends says nothing about the worker: only what it said does.
    socket.on('close', () => answer('unanswered'));
    socket.on('error', () => answer('unanswered'));
  });
}

/** The worker to talk to, or undefined when one has to be started.
 *
 * Any number of windows may share a worker, so no window may stop one out
 * from under the others: a worker on another build is ASKED to step down,
 * and it only does when nothing it is doing would be lost. */
async function usableWorker(sessionId: string): Promise<WorkerRuntimeRecord | undefined> {
  const record = await findRunningWorker(sessionId);
  if (!record) return undefined;
  return (await retireIfStale(record)) ?? undefined;
}

/** Asks one worker to step down when its recorded build is not this process's.
 * Returns the record when it must be kept (same build, or busy), undefined
 * when it is gone and a replacement may be spawned. */
async function retireIfStale(record: WorkerRuntimeRecord): Promise<WorkerRuntimeRecord | undefined> {
  const build = currentWorkerBuild();
  // Unknown own build: nothing to compare, so nothing is retired.
  if (!build || record.build === build) return record;
  const answer = await askToRetire(record);
  if (answer === 'declined') return record;
  if (answer === 'retired') return (await socketReleased(record)) ? undefined : record;
  // No answer: kept. A window never stops a worker it cannot ask -- but one
  // that is no longer there (it went while being asked) is not attached to.
  return (await recordIsLive(record)) ? record : undefined;
}

/** Ends a worker that accepted two attaches and answered neither, by the pid in its record, and
 * waits for its socket to be free for the replacement. Only that one process is signalled: never a
 * process group, which a worker started over a shared session may be in with other things. */
async function replaceUnresponsiveWorker(record: WorkerRuntimeRecord): Promise<void> {
  lifecycle('client.worker.unresponsive', { worker: record.sessionId, workerPid: record.pid });
  const current = await readWorkerRecord(record.sessionId);
  // Another window already replaced it: the record is no longer the one that was silent.
  if (current && current.pid !== record.pid) return;
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    if (!processAlive(record.pid)) break;
    try { process.kill(record.pid, signal); } catch { break; }
    if (await socketReleased(record)) break;
  }
}

/** Asks every worker still running a different build to step down. Idle ones
 * exit now; busy ones exit when their turn ends. Called when this window
 * notices a rebuild: an unattached worker sees the rebuild on its own, but
 * one held by a window that is never idle enough to re-exec would otherwise
 * keep the old code for as long as that window stays open. */
export async function retireStaleWorkers(): Promise<void> {
  const build = currentWorkerBuild();
  if (!build) return;
  const records = await listWorkerRecords();
  await Promise.all(records.map(async (record) => {
    if (record.build === build) return;
    if (!await workerIsReachable(record.socketPath)) return;
    await retireIfStale(record);
  }));
}

/** An existing worker's record, only if it is genuinely still there --
 * `workerIsReachable` is the entire liveness question (see registry.ts for
 * why a PID check alone is not this). A record whose socket refuses a
 * connection is stale, most likely a worker that exited without cleaning up
 * after itself (a crash, a kill -9); harmless to leave for the next
 * spawn to overwrite. */
async function findRunningWorker(sessionId: string): Promise<WorkerRuntimeRecord | undefined> {
  const record = await readWorkerRecord(sessionId);
  if (!record) return undefined;
  return (await recordIsLive(record)) ? record : undefined;
}

/** The record's own worker is there: its socket answers, and it is that
 * record's process answering. The socket path is the conversation's, not one
 * worker's: a killed worker leaves its record behind, and the next one
 * listens on the same path before it writes its own -- connecting with the
 * old record's token then is refused ("stale or invalid token"). */
async function recordIsLive(record: WorkerRuntimeRecord): Promise<boolean> {
  return processAlive(record.pid) && workerIsReachable(record.socketPath);
}

/** A chat that just arrived on this machine (moved here): its worker is
 * started -- or the one running is asked -- to warm it, the way a failover's
 * standby is opened (turn/vendor-warm.ts): the vendor started and the
 * conversation loaded into it, no model call. Returns once that is asked;
 * the warming is the worker's, so the move never waits on it. */
export async function warmSessionWorker(sessionId: string): Promise<void> {
  const record = await findRunningWorker(sessionId);
  if (!record) {
    lifecycle('client.worker.spawn', { worker: sessionId, warm: true });
    launchWorker(sessionId, ['--warm']);
    return;
  }
  await tellWorker(record, { type: 'warm', token: record.token });
}

/** The conversation's worker to send a command to without attaching: the one
 * running, else one started for it (as `WorkerClient.attach` would). */
export async function workerForCommands(sessionId: string): Promise<WorkerRuntimeRecord> {
  const running = await usableWorker(sessionId);
  if (running) return running;
  await ensureSessionOnDisk(sessionId);
  return spawnSessionWorker(sessionId);
}

/** Whether the conversation has a worker running now (nothing is attached). */
export async function runningWorker(sessionId: string): Promise<boolean> {
  return Boolean(await findRunningWorker(sessionId));
}

/** A chat that moved off this machine is read-only here: its worker -- and
 * the vendor and MCP servers it holds -- is asked to go now rather than idle
 * out. It decides, as for any retirement: busy, it goes once it is not. */
export async function retireMovedWorker(sessionId: string): Promise<void> {
  const record = await findRunningWorker(sessionId);
  if (record) await askToRetire(record, 'moved');
}

/** One command to a worker, on a connection of its own (no attach): written,
 * and the connection ended. */
function tellWorker(record: WorkerRuntimeRecord, command: ClientCommand): Promise<void> {
  return new Promise((resolveTold) => {
    const socket = connect(record.socketPath);
    const done = (): void => { clearTimeout(timer); socket.destroy(); resolveTold(); };
    const timer = setTimeout(done, RETIRE_ANSWER_MS);
    socket.on('connect', () => { socket.end(encodeFrame(command), done); });
    socket.on('error', done);
  });
}

/** A worker took the connection and never answered the attach. */
class WorkerSilent extends Error {
  constructor() {
    super('the conversation\'s worker did not answer');
    this.name = 'WorkerSilent';
  }
}

/** The connection ended before the worker said anything. */
class ClosedBeforeAnswer extends Error {
  constructor() {
    super('the conversation\'s worker closed the connection before it answered');
    this.name = 'ClosedBeforeAnswer';
  }
}

/** One connection to one session's worker. `send` is fire-and-forget over the
 * socket; events arrive through `.on('event', ...)` exactly as a terminal
 * used to receive them via direct method calls on TERMINAL.active -- the
 * shape carried over on purpose (see turn/observer.ts), only the transport
 * between "something happened" and "something is told about it" changed.
 *
 * One exception: the very first event, attach's own answering snapshot (or
 * attach-rejected), is consumed here and never reaches `.on('event', ...)`
 * at all -- exposed instead as `initialSnapshot`. A caller about to submit
 * a turn (turn-bridge.ts's runTurnThroughWorker, the only caller today)
 * sets up its OWN listener strictly AFTER attach() resolves, which means
 * without this it would see the pre-submit snapshot -- the session as it
 * was BEFORE the message about to be sent -- and paint it right over
 * whatever optimistic "here is what you just typed" render the caller
 * already did. Confirmed live, not theoretical: a fake-terminal test
 * caught this exact ordering the first time this shipped. */
export class WorkerClient extends EventEmitter {
  private readonly frames = new FrameDecoder();
  private early: WorkerEvent[] | undefined = [];
  readonly initialSnapshot: Promise<Extract<WorkerEvent, { type: 'snapshot' | 'attach-rejected' }>>;
  /** The same event, readable synchronously once attach() has resolved. */
  initialEvent: Extract<WorkerEvent, { type: 'snapshot' | 'attach-rejected' }> | undefined;
  /** Events held behind a snapshot still being completed from disk, so none
   * overtakes it: delivery stays in the order the worker sent them. */
  private behind = 0;
  private order: Promise<void> = Promise.resolve();

  private constructor(private readonly socket: Socket) {
    super();
    let resolveInitial!: (event: Extract<WorkerEvent, { type: 'snapshot' | 'attach-rejected' }>) => void;
    let rejectInitial!: (error: Error) => void;
    let sawInitial = false;
    this.initialSnapshot = new Promise((resolve, reject) => { resolveInitial = resolve; rejectInitial = reject; });
    // Settled by an attach that is no longer waiting on it (timed out, given up): not an unhandled rejection.
    this.initialSnapshot.catch(() => undefined);
    const deliver = (event: WorkerEvent): void => {
      if (!sawInitial && (event.type === 'snapshot' || event.type === 'attach-rejected')) {
        sawInitial = true;
        this.initialEvent = event;
        resolveInitial(event);
        return;
      }
      // Anything before the snapshot is already in it. A worker from before
      // attach was atomic joined a window to its broadcast and then read
      // the conversation, so what streamed during that read came first AND
      // inside the snapshot's text; replayed, it was drawn twice.
      if (!sawInitial) return;
      // Events that arrive in the same chunk as the snapshot -- an approval
      // re-offered on attach, a turn's first delta -- come before attach()
      // has even returned, so before anyone could listen. Held until the
      // first listener, instead of emitted to nobody.
      if (this.early) this.early.push(event);
      else this.emit('event', event);
    };
    socket.on('data', (chunk) => {
      for (const message of this.frames.push(chunk)) {
        const event = message as WorkerEvent;
        // The saved messages of a slim snapshot are read from disk first; what
        // the worker sent after it waits for them.
        if (this.behind === 0 && !(event.type === 'snapshot' && event.saved)) { deliver(event); continue; }
        this.behind += 1;
        this.order = this.order.then(async () => {
          try {
            deliver(event.type === 'snapshot' ? await withSavedConversation(event) : event);
          } catch (error) {
            const reason = error instanceof Error ? error : new Error(String(error));
            lifecycle('client.worker.snapshot-unread', { message: reason.message });
            // The first one failing is the attach failing; a later one is dropped, and the next brings the conversation up to date.
            if (!sawInitial) rejectInitial(reason);
          } finally {
            this.behind -= 1;
          }
        });
      }
    });
    this.on('newListener', (name) => {
      if (name !== 'event' || !this.early) return;
      const held = this.early;
      this.early = undefined;
      queueMicrotask(() => { for (const event of held) this.emit('event', event); });
    });
    socket.on('close', () => {
      lifecycle('client.worker.closed');
      const ended = (): void => {
        // Closed before it ever answered: the attach has failed now, not when a timer says so.
        if (!sawInitial) rejectInitial(new ClosedBeforeAnswer());
        this.emit('close');
      };
      if (this.behind === 0) ended(); else void this.order.then(ended);
    });
  }

  static async attach(sessionId: string): Promise<WorkerClient> {
    const running = await usableWorker(sessionId);
    if (running) {
      try {
        return await WorkerClient.connectTo(running);
      } catch (first) {
        if (!(first instanceof WorkerSilent)) throw first;
      }
      // Silent once may be a busy moment; silent twice is a worker that will not answer, and a
      // window that cannot ask it to step down must not wait on it for ever (a turn it held is
      // journaled and picked up by the replacement).
      try {
        return await WorkerClient.connectTo(running);
      } catch (second) {
        if (!(second instanceof WorkerSilent)) throw second;
      }
      await replaceUnresponsiveWorker(running);
      await ensureSessionOnDisk(sessionId);
      return WorkerClient.connectTo(await spawnSessionWorker(sessionId));
    }
    // The worker is another process and reads the chat from disk. A new
    // chat is a draft in this one until it is used, and starting its worker
    // is using it: one started first found nothing and crashed.
    await ensureSessionOnDisk(sessionId);
    return WorkerClient.connectTo(await spawnSessionWorker(sessionId));
  }

  /** The session's worker if one is already running; never starts one. A
   * window at its prompt uses this to follow turns it did not start. */
  static async attachExisting(sessionId: string): Promise<WorkerClient | undefined> {
    const record = await usableWorker(sessionId);
    return record ? WorkerClient.connectTo(record) : undefined;
  }

  /** One reconnect, and only for a connection lost before the worker answered
   * (the worker is still there to be asked again); any other failure is the
   * answer. */
  private static async connectTo(record: WorkerRuntimeRecord): Promise<WorkerClient> {
    try {
      return await WorkerClient.connectOnce(record);
    } catch (error) {
      if (!(error instanceof ClosedBeforeAnswer)) throw error;
      return WorkerClient.connectOnce(record);
    }
  }

  private static async connectOnce(record: WorkerRuntimeRecord): Promise<WorkerClient> {
    const socket = await new Promise<Socket>((resolveSocket, rejectSocket) => {
      const candidate = connect(record.socketPath);
      candidate.once('connect', () => resolveSocket(candidate));
      candidate.once('error', rejectSocket);
    });
    const client = new WorkerClient(socket);
    lifecycle('client.worker.connect', { worker: record.sessionId, workerPid: record.pid });
    // This window reads the saved conversation itself (saved-conversation.ts).
    client.send({ type: 'attach', token: record.token, readsSaved: true });
    // A worker that took the connection and says nothing is not waited on for ever.
    const initial = await Promise.race([
      client.initialSnapshot,
      new Promise<never>((_, reject) => { setTimeout(() => reject(new WorkerSilent()), ATTACH_ANSWER_MS).unref(); }),
    ]).catch((error: unknown) => { client.close(); throw error; });
    if (initial.type === 'attach-rejected') { client.close(); throw new Error(`worker rejected this connection: ${initial.reason}`); }
    return client;
  }

  send(command: ClientCommand): void {
    this.socket.write(encodeFrame(command));
  }

  close(): void {
    this.socket.end();
  }
}
