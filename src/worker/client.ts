/** Finding, spawning, and talking to a session's worker from a terminal
 * client. The client never cares whether the worker it ends up talking to
 * was already running or was just started -- attach() answers the same way
 * either way, which is the whole point: a reconnect is never a special case
 * (see reseedTranscript in tui/prompter.ts for what that used to cost).
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { connect, type Socket } from 'node:net';
import { readWorkerRecord, workerIsReachable, type WorkerRuntimeRecord } from './registry.js';
import { decodeFrames, encodeFrame, type ClientCommand, type WorkerEvent } from './protocol.js';

const SPAWN_TIMEOUT_MS = 5_000;
const SPAWN_POLL_MS = 50;

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
  const child = spawn(process.execPath, workerSpawnArgv(sessionId), {
    stdio: 'ignore', detached: true,
  });
  child.on('error', () => {});
  child.unref();
  const deadline = Date.now() + SPAWN_TIMEOUT_MS;
  for (;;) {
    const record = await readWorkerRecord(sessionId);
    if (record && await workerIsReachable(record.socketPath)) return record;
    if (Date.now() > deadline) throw new Error(`session worker for "${sessionId}" did not start in time`);
    await delay(SPAWN_POLL_MS);
  }
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

export interface WorkerClientEvents {
  event: [WorkerEvent];
  close: [];
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
  private buffer = '';
  readonly initialSnapshot: Promise<Extract<WorkerEvent, { type: 'snapshot' | 'attach-rejected' }>>;

  private constructor(private readonly socket: Socket) {
    super();
    let resolveInitial!: (event: Extract<WorkerEvent, { type: 'snapshot' | 'attach-rejected' }>) => void;
    let sawInitial = false;
    this.initialSnapshot = new Promise((resolve) => { resolveInitial = resolve; });
    socket.on('data', (chunk) => {
      const { messages, rest } = decodeFrames(this.buffer + chunk.toString('utf8'));
      this.buffer = rest;
      for (const message of messages) {
        const event = message as WorkerEvent;
        if (!sawInitial && (event.type === 'snapshot' || event.type === 'attach-rejected')) {
          sawInitial = true;
          resolveInitial(event);
          continue;
        }
        this.emit('event', event);
      }
    });
    socket.on('close', () => this.emit('close'));
  }

  static async attach(sessionId: string): Promise<WorkerClient> {
    const record = (await findRunningWorker(sessionId)) ?? await spawnSessionWorker(sessionId);
    const socket = await new Promise<Socket>((resolveSocket, rejectSocket) => {
      const candidate = connect(record.socketPath);
      candidate.once('connect', () => resolveSocket(candidate));
      candidate.once('error', rejectSocket);
    });
    const client = new WorkerClient(socket);
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
