/** The bridge's attachment to the conversation's worker: attach, follow its
 * events, and stop a turn and see that it lands. */
import { noticeLevel } from './notice-level.js';
import { withSignIn } from '../commands/account.js';
import { localHarnessForCommand } from '../runtime/lazy-bridge.js';
import { loginNativeHarness } from '../harness/transport/native/login.js';
import { WorkerClient } from '../worker/client.js';
import { CONVERSATION_HANDOFF_REASON } from '../worker/registry.js';
import { cancelOrigin, type WorkerEvent } from '../worker/protocol.js';
import { messageOf, TurnFailed } from './bridge-support.js';
import type { BridgeHost } from './bridge-host.js';

export class WorkerLink {
  worker: { sessionId: string; client: WorkerClient } | undefined;
  /** Seen waiting-start without its waiting-stop: a turn is running on this
   * conversation's worker, whichever client started it. */
  workerTurnRunning = false;
  private handedOffWorker: WorkerClient | undefined;
  /** The last turn ended stopped: nothing queued behind it runs until the user acts. */
  stopped = false;
  turnWaiter: { resolve: () => void; reject: (error: Error) => void; error?: Error } | undefined;

  constructor(private readonly host: Pick<BridgeHost, 'channel' | 'prompter' | 'sessionId' | 'closed' | 'shown' | 'enqueue' | 'report' | 'refreshUsage' | 'scheduleDrain'>) {}

  async workerFor(sessionId: string): Promise<WorkerClient> {
    if (this.worker?.sessionId === sessionId) return this.worker.client;
    this.detach();
    const client = await WorkerClient.attach(sessionId);
    const initial = await client.initialSnapshot;
    this.worker = { sessionId, client };
    this.workerTurnRunning = initial.type === 'snapshot' && Boolean(initial.live);
    this.host.channel.send({ type: 'worker', sessionId, event: initial });
    client.on('event', (event: WorkerEvent) => this.onWorkerEvent(sessionId, client, event));
    client.on('close', () => {
      if (this.worker?.client !== client) return;
      const midTurn = this.workerTurnRunning || Boolean(this.turnWaiter);
      const handedOff = this.handedOffWorker === client;
      this.handedOffWorker = undefined;
      this.worker = undefined;
      this.workerTurnRunning = false;
      if (midTurn) this.failTurn(new Error('session worker connection closed unexpectedly'));
      // The worker left -- retired for a newer build, timed out, or dropped
      // this window for reading too slowly. Attach to it again (or to its
      // replacement): its snapshot says whether a turn still runs, and a
      // panel told nothing else would show one for ever.
      if (handedOff || this.host.closed || this.host.sessionId !== sessionId) return;
      this.host.enqueue(async () => {
        if (this.host.closed || this.host.sessionId !== sessionId || this.worker) return;
        await this.workerFor(sessionId).catch(() => undefined);
      });
    });
    return client;
  }

  /** Stop: sent to the worker, attached on the way if need be. The worker
   * answers (`stopping`, then the turn's end, or `stop-done`); this keeps no
   * clock and sends nothing twice. */
  async cancelTurn(restoreDraft: boolean, trigger: 'editor-stop' | 'programmatic' = 'editor-stop'): Promise<void> {
    const id = this.host.sessionId;
    try {
      const client = this.worker?.client ?? (id ? await this.workerFor(id) : undefined);
      client?.send({ type: 'cancel', restoreDraft, origin: cancelOrigin('bridge', trigger) });
    } catch (error) { this.host.report(error); }
  }

  detach(): void {
    const worker = this.worker;
    if (!worker) return;
    this.worker = undefined;
    this.workerTurnRunning = false;
    try { worker.client.send({ type: 'detach' }); worker.client.close(); } catch { /* already gone */ }
  }

  onWorkerEvent(sessionId: string, client: WorkerClient, event: WorkerEvent): void {
    this.host.channel.send({ type: 'worker', sessionId, event, ...(event.type === 'note' ? { level: noticeLevel(event.message) } : {}) });
    switch (event.type) {
      case 'waiting-start':
        this.workerTurnRunning = true;
        this.stopped = false;
        return;
      case 'sign-in-request':
        // The worker has no terminal; the editor has one. The worker retries
        // the turn once this answers.
        // The sign-in runs here and shows in the panel, like every other. It
        // is the turn's, which holds the queue anyway: not the job that
        // happened to attach this worker.
        void this.host.prompter.holding(undefined, () => withSignIn(this.host.prompter, event.name, async () => {
          const harness = localHarnessForCommand(event.command);
          if (!harness) throw new Error(`unknown harness ${event.command}`);
          await loginNativeHarness({ ...harness, loginArgv: event.argv }, event.environment);
        }))
          .then(() => client.send({ type: 'sign-in-response', id: event.id }),
            (error: unknown) => client.send({ type: 'sign-in-response', id: event.id, error: messageOf(error) }));
        return;
      case 'turn-error':
        if (this.turnWaiter) this.turnWaiter.error = new TurnFailed(event.message);
        return;
      case 'waiting-stop': {
        this.workerTurnRunning = false;
        this.stopped = event.stopped === true;
        const waiter = this.turnWaiter;
        this.turnWaiter = undefined;
        // The turn's cost is on the conversation's figure now.
        if (this.host.shown) void this.host.refreshUsage().catch(() => undefined);
        if (waiter) (waiter.error ? waiter.reject(waiter.error) : waiter.resolve());
        // A turn this editor only followed (a terminal's, or one the worker
        // started) ended: what was queued behind it is this client's to send.
        // Its own turn's caller drains once the turn returns.
        else this.host.scheduleDrain();
        return;
      }
      case 'queue-changed':
        // Something was queued or consumed: nothing runs it but a client, and
        // the one that queued it may be this editor following another's turn.
        this.host.scheduleDrain();
        return;
      case 'submit-queued': {
        // The worker had a turn running and queued this submit behind it.
        // The waiter resolves at that turn's waiting-stop and the drain sends
        // the message then; if that stop came first, nothing is left to wait
        // for, and resending now cannot land in a running turn.
        if (this.workerTurnRunning) return;
        const waiter = this.turnWaiter;
        this.turnWaiter = undefined;
        waiter?.resolve();
        return;
      }
      case 'shutdown':
        // A handoff leaves this panel open without reclaiming the worker on
        // the old machine. Another shutdown reconnects as before.
        if (event.reason === CONVERSATION_HANDOFF_REASON) this.handedOffWorker = client;
        if (this.workerTurnRunning || this.turnWaiter) this.failTurn(new Error(`session worker exited mid-turn: ${event.reason}`));
        return;
      default:
        return;
    }
  }

  failTurn(error: Error): void {
    const waiter = this.turnWaiter;
    this.turnWaiter = undefined;
    waiter?.reject(error);
  }

  /** A turn is running here, or this client is waiting on one it sent. */
  get running(): boolean {
    return this.workerTurnRunning || Boolean(this.turnWaiter);
  }
}
