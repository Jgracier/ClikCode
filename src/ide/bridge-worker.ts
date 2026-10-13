/** The bridge's attachment to the conversation's worker: attach, follow its
 * events, and stop a turn and see that it lands. */
import { noticeLevel } from './notice-level.js';
import { withSignIn } from '../commands/account.js';
import { localHarnessForCommand } from '../runtime/lazy-bridge.js';
import { loginNativeHarness } from '../harness/transport/native/login.js';
import { WorkerClient } from '../worker/client.js';
import type { WorkerEvent } from '../worker/protocol.js';
import { STOP_RESEND_MS, STOP_RESENDS } from '../worker/stop-resend.js';
import { messageOf, TurnFailed } from './bridge-support.js';
import type { BridgeHost } from './bridge-host.js';

export class WorkerLink {
  worker: { sessionId: string; client: WorkerClient } | undefined;
  /** Seen waiting-start without its waiting-stop: a turn is running on this
   * conversation's worker, whichever client started it. */
  workerTurnRunning = false;
  turnWaiter: { resolve: () => void; reject: (error: Error) => void; error?: Error } | undefined;
  stopWatch: NodeJS.Timeout | undefined;

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
      this.worker = undefined;
      this.workerTurnRunning = false;
      if (midTurn) { this.failTurn(new Error('session worker connection closed unexpectedly')); return; }
      // An idle worker left -- retired for a newer build, or timed out. Not
      // the user's concern: attach to (or start) its replacement so this
      // window keeps following the conversation.
      if (this.host.closed || this.host.sessionId !== sessionId) return;
      this.host.enqueue(async () => {
        if (this.host.closed || this.host.sessionId !== sessionId || this.worker) return;
        await this.workerFor(sessionId).catch(() => undefined);
      });
    });
    return client;
  }

  /** Stop, and see that it lands. The editor shows "stopping" until the turn
   * ends, so a Stop that never reached a turn -- no worker attached just then,
   * or one that arrived before the worker had started the turn -- left it
   * stopping for as long as the turn ran. The cancel is sent to a worker found
   * or reattached, and sent again while the turn is still running; when none
   * is, the worker is asked for a snapshot, which ends the editor's turn. */
  async cancelTurn(restoreDraft: boolean): Promise<void> {
    const id = this.host.sessionId;
    try {
      const client = this.worker?.client ?? (id ? await this.workerFor(id) : undefined);
      client?.send({ type: 'cancel', restoreDraft });
    } catch (error) { this.host.report(error); }
    clearInterval(this.stopWatch);
    let looks = 0;
    this.stopWatch = setInterval(() => {
      looks += 1;
      const running = this.workerTurnRunning || Boolean(this.turnWaiter);
      if (this.host.closed || looks > STOP_RESENDS || (!running && looks > 1)) { clearInterval(this.stopWatch); this.stopWatch = undefined; }
      const client = this.worker?.client;
      if (!client || this.host.closed) return;
      // Still running: ask again (the draft was restored, or not, by the first).
      // Not running: nothing was cancelled, so bring the editor up to date.
      client.send(running ? { type: 'cancel', restoreDraft: false } : { type: 'refresh' });
    }, STOP_RESEND_MS);
    this.stopWatch.unref();
  }

  detach(): void {
    const worker = this.worker;
    if (!worker) return;
    this.worker = undefined;
    this.workerTurnRunning = false;
    try { worker.client.send({ type: 'detach' }); worker.client.close(); } catch { /* already gone */ }
  }

  onWorkerEvent(sessionId: string, client: WorkerClient, event: WorkerEvent): void {
    this.host.channel.send({ type: 'worker', sessionId, event, ...(event.type === 'note' || event.type === 'notice' ? { level: noticeLevel(event.message) } : {}) });
    switch (event.type) {
      case 'waiting-start':
        this.workerTurnRunning = true;
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
        clearInterval(this.stopWatch);
        this.stopWatch = undefined;
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
        // A worker only retires idle; the close that follows reattaches.
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
