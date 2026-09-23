/** The worker's own TurnObserver: satisfies exactly what turn/drive.ts and
 * gateway/harness.ts need from "whoever is watching this turn", by
 * broadcasting to every currently-attached client socket instead of
 * painting a terminal directly. This is the one place a worker and a real
 * TerminalHarnessPrompter genuinely differ in behaviour -- everywhere else,
 * drive.ts cannot tell the difference, by construction (see turn/observer.ts).
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
import type { TurnObserver } from '../turn/observer.js';
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
  private readonly pendingApprovals = new Map<string, (approved: boolean | 'always') => void>();

  attach(socket: Socket): void {
    this.clients.add(socket);
  }

  detach(socket: Socket): void {
    this.clients.delete(socket);
  }

  get attachedCount(): number {
    return this.clients.size;
  }

  /** What a freshly-attached client needs painted immediately: the turn in
   * flight, if any, exactly as far along as it has actually gotten. */
  liveSnapshot(): { text: string; waitingLabel: string } | undefined {
    return this.waitingLabel ? { text: this.liveText, waitingLabel: this.waitingLabel } : undefined;
  }

  resolveApproval(id: string, approved: boolean | 'always'): void {
    const resolve = this.pendingApprovals.get(id);
    if (!resolve) return;
    this.pendingApprovals.delete(id);
    resolve(approved);
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
    return new Promise((resolveApproval) => {
      this.pendingApprovals.set(id, resolveApproval);
      this.broadcast({ type: 'approval-request', id, title, ...(detail ? { detail } : {}), ...(preview ? { preview } : {}), ...(rule ? { rule } : {}) });
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
  startWaiting(message: string, _onCancel?: (restoreDraft: boolean) => void, _onSubmit?: (text: string) => Promise<LiveTurnInputResult>): void {
    this.liveText = '';
    this.waitingLabel = message;
    this.outputStarted = false;
    this.broadcast({ type: 'waiting-start', message });
  }

  stopWaiting(): void {
    this.waitingLabel = '';
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
  async suspend(): Promise<void> {
    this.broadcast({ type: 'suspend' });
  }

  resume(): void {
    this.broadcast({ type: 'resume' });
  }
}
