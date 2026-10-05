/** Finding, spawning, and talking to a session's worker from a terminal
 * client. The client never cares whether the worker it ends up talking to
 * was already running or was just started -- attach() answers the same way
 * either way, which is the whole point: a reconnect is never a special case
 * (see reseedTranscript in tui/prompter.ts for what that used to cost).
 */
import { lifecycle } from '../runtime/lifecycle-log.js';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { connect, type Socket } from 'node:net';
import { conversationHolder, currentWorkerBuild, listWorkerRecords, readWorkerRecord, workerIsReachable, type WorkerRuntimeRecord } from './registry.js';
import { readState } from '../session/state/read.js';
import { encodeFrame, FrameDecoder, type ClientCommand, type WorkerEvent } from './protocol.js';

const SPAWN_TIMEOUT_MS = 5_000;
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
function workerSpawnArgv(sessionId: string): string[] {
  const entry = process.env.CLIKCODE_WORKER_ENTRY ?? process.argv[1]!;
  return [entry, 'session-worker', sessionId];
}

/** Starts a fresh worker for a session and waits until its socket actually
 * accepts a connection -- not until the child process merely exists, which
 * would race the worker's own listen() call. */
async function spawnSessionWorker(sessionId: string): Promise<WorkerRuntimeRecord> {
  lifecycle('client.worker.spawn', { worker: sessionId });
  const child = spawn(process.execPath, workerSpawnArgv(sessionId), {
    // windowsHide: a detached child on Windows otherwise opens a console
    // window of its own for as long as the worker lives.
    stdio: 'ignore', detached: true, windowsHide: true,
  });
  child.on('error', () => {});
  child.unref();
  const deadline = Date.now() + SPAWN_TIMEOUT_MS;
  for (;;) {
    const record = await readWorkerRecord(sessionId);
    if (record && await workerIsReachable(record.socketPath)) return record;
    // A scripted send is running a turn in-process: the worker starts when it
    // ends, and this waits for it like any turn already running.
    if (Date.now() > deadline && (await conversationHolder(sessionId))?.kind !== 'turn') {
      throw new Error(`session worker for "${sessionId}" did not start in time`);
    }
    await delay(SPAWN_POLL_MS);
  }
}

/** How long to wait for a retired worker to actually let go of its socket.
 * It shuts down gracefully on SIGTERM (session-worker.ts) -- telling its
 * clients, removing its record, unlinking the socket -- and that is fast, but
 * it is not instant and spawning a replacement onto a path still held is the
 * one way this can go wrong. */
const RETIRE_TIMEOUT_MS = 3_000;

/** A worker running different code than this client is not reused.
 *
 * A worker loads its entry once, at spawn, and then outlives every client:
 * reinstalling ClikCode and reopening the TUI left a new client talking to a
 * worker still running the old build, and every fix looked like it had not
 * landed. Restarting the terminal is the obvious thing to try and it does not
 * help, which is what makes this worth enforcing here rather than documenting.
 *
 * A turn in flight is the exception, and it is not a compromise: the user is
 * mid-answer, and finishing that matters more than this client's freshness.
 * The stale worker is then reused, and retired the next time nothing is
 * running -- which the next attach, after that turn, is. */
async function retireWorker(record: WorkerRuntimeRecord): Promise<boolean> {
  lifecycle('client.worker.retire', { worker: record.sessionId, workerPid: record.pid });
  try { process.kill(record.pid, 'SIGTERM'); } catch { return true; }
  return socketReleased(record);
}

async function socketReleased(record: WorkerRuntimeRecord): Promise<boolean> {
  const deadline = Date.now() + RETIRE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!await workerIsReachable(record.socketPath, 200)) return true;
    await delay(SPAWN_POLL_MS);
  }
  return false;
}

async function turnInFlight(sessionId: string): Promise<boolean> {
  try {
    const state = await readState({ transcripts: [sessionId] });
    return Boolean(state.sessions.find((item) => item.id === sessionId)?.pendingTurn);
  } catch {
    // Unreadable state is not evidence a turn is running, but it is not
    // evidence one is not either. Keep the worker: reusing a stale worker is
    // a wrong build, killing one mid-turn is a lost answer.
    return true;
  }
}

/** How long a worker has to answer `retire` before it is taken to be one
 * from before the command existed. A worker answers within milliseconds even
 * mid-turn; this is only ever waited out in full by an old one, and a message
 * sent right after switching waits on it. */
const RETIRE_ANSWER_MS = 500;

/** Asks a worker on another build to step down. It knows whether it is in
 * the middle of something and the asking window does not -- so it decides:
 * `retired` (it is shutting down), `declined` (busy; it goes once it is not),
 * or `unanswered` (a worker older than the question). */
function askToRetire(record: WorkerRuntimeRecord): Promise<'retired' | 'declined' | 'unanswered'> {
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
      socket.write(encodeFrame({ type: 'attach', token: record.token } satisfies ClientCommand));
      socket.write(encodeFrame({ type: 'retire' } satisfies ClientCommand));
    });
    socket.on('data', (chunk) => {
      for (const message of frames.push(chunk) as WorkerEvent[]) {
        if (message.type === 'retire-declined') answer('declined');
        else if (message.type === 'attach-rejected') answer('unanswered');
        else if (message.type === 'shutdown') answer('retired');
      }
    });
    socket.on('close', () => answer('retired'));
    socket.on('error', () => answer('retired'));
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
  // A worker from before `retire`: the journal is the only evidence left of
  // what it is doing. These age out as their conversations go idle.
  if (await turnInFlight(record.sessionId)) return record;
  return (await retireWorker(record)) ? undefined : record;
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
  return (await workerIsReachable(record.socketPath)) ? record : undefined;
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

  private constructor(private readonly socket: Socket) {
    super();
    let resolveInitial!: (event: Extract<WorkerEvent, { type: 'snapshot' | 'attach-rejected' }>) => void;
    let sawInitial = false;
    this.initialSnapshot = new Promise((resolve) => { resolveInitial = resolve; });
    socket.on('data', (chunk) => {
      for (const message of this.frames.push(chunk)) {
        const event = message as WorkerEvent;
        if (!sawInitial && (event.type === 'snapshot' || event.type === 'attach-rejected')) {
          sawInitial = true;
          this.initialEvent = event;
          resolveInitial(event);
          continue;
        }
        // Anything before the snapshot is already in it. A worker from before
        // attach was atomic joined a window to its broadcast and then read
        // the conversation, so what streamed during that read came first AND
        // inside the snapshot's text; replayed, it was drawn twice.
        if (!sawInitial) continue;
        // Events that arrive in the same chunk as the snapshot -- an approval
        // re-offered on attach, a turn's first delta -- come before attach()
        // has even returned, so before anyone could listen. Held until the
        // first listener, instead of emitted to nobody.
        if (this.early) this.early.push(event);
        else this.emit('event', event);
      }
    });
    this.on('newListener', (name) => {
      if (name !== 'event' || !this.early) return;
      const held = this.early;
      this.early = undefined;
      queueMicrotask(() => { for (const event of held) this.emit('event', event); });
    });
    socket.on('close', () => { lifecycle('client.worker.closed'); this.emit('close'); });
  }

  static async attach(sessionId: string): Promise<WorkerClient> {
    return WorkerClient.connectTo((await usableWorker(sessionId)) ?? await spawnSessionWorker(sessionId));
  }

  /** The session's worker if one is already running; never starts one. A
   * window at its prompt uses this to follow turns it did not start. */
  static async attachExisting(sessionId: string): Promise<WorkerClient | undefined> {
    const record = await usableWorker(sessionId);
    return record ? WorkerClient.connectTo(record) : undefined;
  }

  private static async connectTo(record: WorkerRuntimeRecord): Promise<WorkerClient> {
    const socket = await new Promise<Socket>((resolveSocket, rejectSocket) => {
      const candidate = connect(record.socketPath);
      candidate.once('connect', () => resolveSocket(candidate));
      candidate.once('error', rejectSocket);
    });
    const client = new WorkerClient(socket);
    lifecycle('client.worker.connect', { worker: record.sessionId, workerPid: record.pid });
    client.send({ type: 'attach', token: record.token });
    const initial = await client.initialSnapshot;
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
