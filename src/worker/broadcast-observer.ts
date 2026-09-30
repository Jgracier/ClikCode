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
import type { HarnessSession } from '../session/model.js';
import type { PlanEntry } from '../tui/render/plan-block.js';
import type { ApprovalPreview } from '../tui/render/approval-block.js';
import type { LiveTurnInputResult } from '../turn/live-input.js';
import type { SignInRequest, TurnObserver } from '../turn/observer.js';
import { encodeFrame, type WorkerEvent } from './protocol.js';

export class BroadcastObserver implements TurnObserver {
  private readonly clients = new Set<Socket>();
  /** Mirrors exactly what a client would have painted, so `snapshot()` can
   * hand a late attacher the same thing an already-attached client already
   * sees -- not a re-derivation, a read of the one copy this class owns. */
  private liveText = '';
  private waitingLabel = '';
  /** Mirrors TerminalHarnessPrompter.turnOutputStarted(): true once ANY
   * visible content -- an answer token or a tool activity line -- has
   * streamed for the turn currently in flight. What a cancel handler needs
   * to decide between preserveInterruptedTurn (something real to keep) and
   * discardInterruptedTurn (nothing happened yet, safe to drop entirely). */
  private outputStarted = false;
  /** What the running turn was started with (see WorkerEvent's waiting-start). */
  private livePrompt: string | undefined;
  /** Each open request is kept WITH the event that asked it, so a client
   * attaching later is asked too (reofferPending). They used to go only to
   * whoever was attached at that moment: a turn waiting on an approval with
   * nobody watching waited forever, and reattaching showed nothing to answer. */
  private readonly pendingApprovals = new Map<string, { resolve: (approved: boolean | 'always') => void; event: WorkerEvent }>();
  private readonly pendingSignIns = new Map<string, { resolve: () => void; reject: (error: Error) => void; event: WorkerEvent }>();

  attach(socket: Socket): void {
    this.clients.add(socket);
  }

  /** Sent to a client that just attached, after its snapshot. */
  reofferPending(socket: Socket): void {
    for (const pending of [...this.pendingApprovals.values(), ...this.pendingSignIns.values()]) socket.write(encodeFrame(pending.event));
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
  liveSnapshot(): { text: string; waitingLabel: string; prompt?: string } | undefined {
    return this.waitingLabel ? { text: this.liveText, waitingLabel: this.waitingLabel, ...(this.livePrompt !== undefined ? { prompt: this.livePrompt } : {}) } : undefined;
  }

  resolveApproval(id: string, approved: boolean | 'always'): void {
    const pending = this.pendingApprovals.get(id);
    if (!pending) return;
    this.pendingApprovals.delete(id);
    pending.resolve(approved);
  }

  /** A turn's end, whatever it was: nobody is left to answer what it asked. */
  private dropPending(): void {
    for (const pending of this.pendingApprovals.values()) pending.resolve(false);
    this.pendingApprovals.clear();
    for (const pending of this.pendingSignIns.values()) pending.reject(new Error('the turn ended'));
    this.pendingSignIns.clear();
  }

  private broadcast(event: WorkerEvent): void {
    const frame = encodeFrame(event);
    for (const client of this.clients) client.write(frame);
  }

  render(session: HarnessSession, account?: string, notice?: string): void {
    this.broadcast({ type: 'snapshot', session, ...(account ? { account } : {}), ...(this.liveSnapshot() ? { live: this.liveSnapshot() } : {}) });
    if (notice) this.broadcast({ type: 'notice', message: notice });
  }

  response(text: string, mode: 'append' | 'replace' = 'append'): void {
    if (text) this.outputStarted = true;
    this.liveText = mode === 'replace' ? text : this.liveText + text;
    this.broadcast({ type: 'delta', text, mode });
  }

  activity(message: string): void {
    this.outputStarted = true;
    this.broadcast({ type: 'activity', event: { kind: 'thinking', label: message } });
  }

  activityEvent(event: HarnessActivityEvent): void {
    this.outputStarted = true;
    this.broadcast({ type: 'activity', event });
  }

  phase(message: string): void {
    this.broadcast({ type: 'phase', message });
  }

  setPlan(entries: readonly PlanEntry[]): void {
    this.broadcast({ type: 'plan', entries });
  }

  setTurnUsage(usage: { inputTokens?: number; outputTokens?: number }): void {
    this.broadcast({ type: 'usage', usage });
  }

  approval(title: string, detail?: string, preview?: ApprovalPreview, rule?: string): Promise<boolean | 'always'> {
    const id = randomUUID();
    const event: WorkerEvent = { type: 'approval-request', id, title, ...(detail ? { detail } : {}), ...(preview ? { preview } : {}), ...(rule ? { rule } : {}) };
    return new Promise((resolveApproval) => {
      this.pendingApprovals.set(id, { resolve: resolveApproval, event });
      this.broadcast(event);
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
    this.liveText = '';
    this.waitingLabel = message;
    this.livePrompt = prompt;
    this.outputStarted = false;
    this.broadcast({ type: 'waiting-start', message, ...(prompt !== undefined ? { prompt } : {}) });
  }

  stopWaiting(): void {
    this.waitingLabel = '';
    this.livePrompt = undefined;
    this.dropPending();
    this.broadcast({ type: 'waiting-stop' });
  }

  get turnOutputStarted(): boolean {
    return this.outputStarted;
  }

  get liveResponseText(): string {
    return this.liveText;
  }

  /** A worker has no terminal to hand over -- it was spawned detached, with
   * no TTY of its own to suspend. This is the one real gap the client/worker
   * split does not resolve on its own (flagged when the split was planned):
   * a vendor CLI's interactive login, mid-turn, genuinely needs a real
   * terminal. Broadcasting the event lets an attached client show that a
   * turn is blocked on something it cannot do remotely, rather than hanging
   * with no explanation; actually completing the login is out of scope
   * here and is expected to surface as the turn failing with an
   * authentication error the client's own (local, client-side) /login flow
   * then handles the normal way. */
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

  async suspend(): Promise<void> {
    this.broadcast({ type: 'suspend' });
  }

  resume(): void {
    this.broadcast({ type: 'resume' });
  }
}
