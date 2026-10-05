/** The worker's own TurnObserver: satisfies exactly what the turn code and
 * gateway/harness.ts need from "whoever is watching this turn", by
 * broadcasting to every currently-attached client socket instead of
 * painting a terminal directly. This is the one place a worker and a real
 * TerminalHarnessPrompter genuinely differ in behaviour -- everywhere else,
 * the turn cannot tell the difference, by construction (see turn/observer.ts).
 *
 * Also the one in-memory copy of "what has streamed so far" a late-attaching
 * client's snapshot is built from -- there is no second copy anywhere to
 * drift from it, which is the entire point of this architecture (see
 * clikcode-worker-client-split project memory for why that matters).
 */
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import type { HarnessActivityEvent } from '../harness/prompter.js';
import type { TurnUsage } from '../harness/protocol/turn-usage.js';
import type { HarnessSession } from '../session/model.js';
import type { PlanEntry } from '../tui/render/plan-block.js';
import type { ApprovalPreview } from '../tui/render/approval-block.js';
import type { LiveTurnInputResult } from '../turn/live-input.js';
import type { SignInRequest, TurnObserver } from '../turn/observer.js';
import { encodeFrame, isTranscriptActivity, type LiveActivity, type LiveTurn, type WorkerEvent } from './protocol.js';

/** How far a window may fall behind before it is let go. A window that stops
 * reading -- a suspended terminal, a hung process -- would otherwise have
 * every event of every turn held for it in this worker's memory, without
 * bound. Closed, it attaches again when it next reads, and the snapshot it
 * gets then is whole: nothing is lost by dropping what it did not read. */
const MAX_UNREAD_BYTES = 16 * 1024 * 1024;

/** Writes one event to one window, unless that window is too far behind. */
export function sendEvent(socket: Socket, event: WorkerEvent): void {
  if (socket.destroyed) return;
  if (socket.writableLength > MAX_UNREAD_BYTES) { socket.destroy(); return; }
  socket.write(encodeFrame(event));
}

export class BroadcastObserver implements TurnObserver {
  private readonly clients = new Set<Socket>();
  /** Mirrors exactly what a client would have painted, so `snapshot()` can
   * hand a late attacher the same thing an already-attached client already
   * sees -- not a re-derivation, a read of the one copy this class owns. */
  private liveText = '';
  private waitingLabel = '';
  /** True once ANY
   * visible content -- an answer token or a tool activity line -- has
   * streamed for the turn currently in flight. What a cancel handler needs
   * to decide between preserveInterruptedTurn (something real to keep) and
   * discardInterruptedTurn (nothing happened yet, safe to drop entirely). */
  private outputStarted = false;
  /** What the running turn was started with (see WorkerEvent's waiting-start). */
  private livePrompt: string | undefined;
  /** The running turn's tool rows and plan, so a window joining it mid-way
   * draws those too, not only its text. */
  private liveActivities: LiveActivity[] = [];
  private livePlan: readonly PlanEntry[] = [];
  /** The turn and the session spool can both report one clerk event. */
  private readonly seenActivity = new Map<string, string>();
  /** Each open request is kept WITH the event that asked it, so a client
   * attaching later is asked too (reofferPending). They used to go only to
   * whoever was attached at that moment: a turn waiting on an approval with
   * nobody watching waited forever, and reattaching showed nothing to answer. */
  private readonly pendingApprovals = new Map<string, { resolve: (approved: boolean | 'always') => void; event: WorkerEvent }>();
  private readonly pendingSignIns = new Map<string, { resolve: () => void; reject: (error: Error) => void; event: WorkerEvent }>();

  /** Told when the oldest approval still waiting changes (undefined: none
   * waits). The worker records it beside its runtime record, so another
   * process can say a conversation is waiting on the user without
   * attaching to it. */
  onAwaitingApproval?: (approval: { title: string; since: string } | undefined) => Promise<void> | void;
  private awaitingSince = new Map<string, string>();

  private announceAwaiting(): Promise<void> | void {
    const first = this.pendingApprovals.entries().next();
    if (first.done) return this.onAwaitingApproval?.(undefined);
    const [id, pending] = first.value;
    const title = pending.event.type === 'approval-request' ? pending.event.title : 'approval';
    return this.onAwaitingApproval?.({ title, since: this.awaitingSince.get(id) ?? new Date().toISOString() });
  }

  attach(socket: Socket): void {
    this.clients.add(socket);
  }

  /** Sent to a client that just attached, after its snapshot. */
  reofferPending(socket: Socket): void {
    for (const pending of [...this.pendingApprovals.values(), ...this.pendingSignIns.values()]) sendEvent(socket, pending.event);
  }

  get pendingRequestCount(): number {
    return this.pendingApprovals.size + this.pendingSignIns.size;
  }

  detach(socket: Socket): void {
    this.clients.delete(socket);
  }

  get attachedCount(): number {
    return this.clients.size;
  }

  /** What a freshly-attached client needs painted immediately: the turn in
   * flight, if any, exactly as far along as it has actually gotten. */
  liveSnapshot(): LiveTurn | undefined {
    if (!this.waitingLabel) return undefined;
    return {
      text: this.liveText, waitingLabel: this.waitingLabel, ...(this.livePrompt !== undefined ? { prompt: this.livePrompt } : {}),
      activities: [...this.liveActivities], plan: [...this.livePlan],
    };
  }

  /** The whole conversation, and the turn in flight if there is one, for one
   * window -- read synchronously, so no event can fall between what the
   * snapshot holds and what the window is sent after it. */
  snapshotFor(socket: Socket, session: HarnessSession, account?: string): void {
    const live = this.liveSnapshot();
    sendEvent(socket, { type: 'snapshot', session, ...(account ? { account } : {}), ...(live ? { live } : {}) });
  }

  resolveApproval(id: string, approved: boolean | 'always'): void {
    const pending = this.pendingApprovals.get(id);
    if (!pending) return;
    this.pendingApprovals.delete(id);
    this.awaitingSince.delete(id);
    pending.resolve(approved);
    this.announceAwaiting();
  }

  /** A turn's end, whatever it was: nobody is left to answer what it asked. */
  private dropPending(): void {
    const hadApprovals = this.pendingApprovals.size > 0;
    for (const pending of this.pendingApprovals.values()) pending.resolve(false);
    this.pendingApprovals.clear();
    this.awaitingSince.clear();
    if (hadApprovals) this.announceAwaiting();
    for (const pending of this.pendingSignIns.values()) pending.reject(new Error('the turn ended'));
    this.pendingSignIns.clear();
  }

  broadcast(event: WorkerEvent): void {
    for (const client of this.clients) sendEvent(client, event);
  }

  render(session: HarnessSession, account?: string, notice?: string): void {
    const live = this.liveSnapshot();
    this.broadcast({ type: 'snapshot', session, ...(account ? { account } : {}), ...(live ? { live } : {}) });
    if (notice) this.broadcast({ type: 'notice', message: notice });
  }

  response(text: string, mode: 'append' | 'replace' = 'append'): void {
    if (text) this.outputStarted = true;
    this.liveText = mode === 'replace' ? text : this.liveText + text;
    this.broadcast({ type: 'delta', text, mode });
  }

  activity(message: string): void {
    this.outputStarted = true;
    this.broadcast({ type: 'note', message });
  }

  activityEvent(event: HarnessActivityEvent): void {
    if (event.id) {
      const key = `${event.id}\0${event.kind}\0${event.parentId ?? ''}\0${event.label}`;
      const value = JSON.stringify(event);
      if (this.seenActivity.get(key) === value) return;
      this.seenActivity.set(key, value);
    }
    this.outputStarted = true;
    if (this.waitingLabel && isTranscriptActivity(event)) this.liveActivities.push({ event, responseOffset: this.liveText.length });
    this.broadcast({ type: 'activity', event });
  }

  phase(message: string): void {
    this.broadcast({ type: 'phase', message });
  }

  setPlan(entries: readonly PlanEntry[]): void {
    if (this.waitingLabel) this.livePlan = entries;
    this.broadcast({ type: 'plan', entries });
  }

  setTurnUsage(usage: TurnUsage): void {
    this.broadcast({ type: 'usage', usage });
  }

  approval(title: string, detail?: string, preview?: ApprovalPreview, rule?: string): Promise<boolean | 'always'> {
    const id = randomUUID();
    const event: WorkerEvent = { type: 'approval-request', id, title, ...(detail ? { detail } : {}), ...(preview ? { preview } : {}), ...(rule ? { rule } : {}) };
    return new Promise((resolveApproval) => {
      this.pendingApprovals.set(id, { resolve: resolveApproval, event });
      this.awaitingSince.set(id, new Date().toISOString());
      // Recorded before anyone is asked: once a window sees the question,
      // the record already says the turn waits on it.
      const recorded = this.announceAwaiting();
      if (recorded instanceof Promise) void recorded.then(() => { if (this.pendingApprovals.has(id)) this.broadcast(event); });
      else this.broadcast(event);
    });
  }

  /** onCancel/onSubmit are part of TurnObserver's shape because a real
   * TerminalHarnessPrompter needs them for its own key handling, but the
   * worker never calls them: a client's `cancel`/`steer` commands are
   * handled directly by session-worker.ts against its own AbortController
   * and LiveTurnInputBroker for the turn currently running, not through the
   * observer at all. Accepted and ignored here rather than left off the
   * signature, so this still satisfies the one interface both a worker and
   * a real terminal are held to. */
  startWaiting(message: string, _onCancel?: (restoreDraft: boolean) => void, _onSubmit?: (text: string) => Promise<LiveTurnInputResult>, _onCommand?: (text: string) => Promise<LiveTurnInputResult>): void {
    this.startTurn(message);
  }

  /** Counts turns started through this observer, user and background alike,
   * so a turn can tell whether the waiting line is still its own. */
  private generation = 0;

  get turnGeneration(): number {
    return this.generation;
  }

  /** startWaiting, naming the prompt the turn runs, for clients following it. */
  startTurn(message: string, prompt?: string): void {
    this.generation++;
    this.seenActivity.clear();
    this.liveText = '';
    this.waitingLabel = message;
    this.livePrompt = prompt;
    this.liveActivities = [];
    this.livePlan = [];
    this.outputStarted = false;
    this.broadcast({ type: 'waiting-start', message, ...(prompt !== undefined ? { prompt } : {}) });
  }

  stopWaiting(): void {
    this.waitingLabel = '';
    this.livePrompt = undefined;
    this.liveActivities = [];
    this.livePlan = [];
    this.dropPending();
    this.broadcast({ type: 'waiting-stop' });
  }

  /** The turn is over: the conversation as it now stands, then waiting-stop.
   * The snapshot goes first because a window stops listening at waiting-stop;
   * it carries no `live`, because nothing is running any more -- a journal it
   * still holds is an interrupted turn, and a window draws it as one. */
  endTurn(session?: HarnessSession, account?: string): void {
    if (session) this.broadcast({ type: 'snapshot', session, ...(account ? { account } : {}) });
    this.stopWaiting();
  }

  get turnOutputStarted(): boolean {
    return this.outputStarted;
  }

  get liveResponseText(): string {
    return this.liveText;
  }

  /** The sign-in runs on the client's terminal (see SignInRequest). With no
   * client attached there is nowhere to run it, so the turn fails with its
   * authentication error and the user signs in on reattaching. */
  signIn(request: SignInRequest): Promise<void> {
    if (this.clients.size === 0) return Promise.reject(new Error(`sign in to ${request.name} needs an open ClikCode window`));
    const id = randomUUID();
    const event: WorkerEvent = { type: 'sign-in-request', id, ...request };
    return new Promise((resolve, reject) => {
      this.pendingSignIns.set(id, { resolve, reject, event });
      this.broadcast(event);
    });
  }

  resolveSignIn(id: string, error?: string): void {
    const pending = this.pendingSignIns.get(id);
    if (!pending) return;
    this.pendingSignIns.delete(id);
    if (error) pending.reject(new Error(error));
    else pending.resolve();
  }
}
