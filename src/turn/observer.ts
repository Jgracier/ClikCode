/** What a running turn may tell whoever is watching it -- and, in the one
 * case that blocks on an answer (approval), ask.
 *
 * TerminalHarnessPrompter satisfies this structurally, with no `implements`
 * needed: TypeScript checks the shape, not the declaration. That is
 * deliberate. The turn code must never import the concrete class (a real TUI
 * renderer, ANSI painting and all) merely to type its own parameter -- a
 * worker's own broadcaster to attached remote clients satisfies the exact
 * same interface without being a terminal at all, or importing one.
 */
import type { HarnessActivityEvent } from '../harness/prompter.js';
import type { TurnUsage } from '../harness/protocol/turn-usage.js';
import type { HarnessSession } from '../session/model.js';
import type { PlanEntry } from '../tui/render/plan-block.js';
import type { ApprovalPreview } from '../tui/render/approval-block.js';
import type { LiveTurnInputResult, TakeBackOutcome } from './live-input.js';

export interface TurnObserver {
  render(session: HarnessSession, account?: string, notice?: string): void;
  response(text: string, mode?: 'append' | 'replace'): void;
  activity(message: string): void;
  activityEvent(event: HarnessActivityEvent): void;
  phase(message: string): void;
  approval(title: string, detail?: string, preview?: ApprovalPreview, rule?: string): Promise<boolean | 'always'>;
  setPlan(entries: readonly PlanEntry[]): void;
  setTurnUsage(usage: TurnUsage): void;
  startWaiting(
    message: string,
    onCancel?: (restoreDraft: boolean) => void,
    onSubmit?: (text: string) => Promise<LiveTurnInputResult>,
    /** A ClikCode slash command typed during the turn: queued, then run when
     * the turn ends. See tui/slash/queue.ts. */
    onCommand?: (text: string) => Promise<LiveTurnInputResult>,
    /** Stop showing this turn and leave it running, where that is possible
     * (a worker's turn: the worker keeps it, and any window can follow it). */
    onLeave?: () => void,
    /** Take a waiting message back out of the queue to edit (Esc). */
    onTakeBack?: (id: string) => Promise<TakeBackOutcome>,
    /** Put the oldest waiting user message into the chat (Enter again).
     *  The turn is not stopped. */
    onSendWaiting?: () => void,
  ): void;
  stopWaiting(refresh?: boolean): void;
  /** Runs a vendor sign-in somewhere with a terminal. A worker has none, so
   * it asks its client; absent, the turn signs in where it runs. */
  signIn?(request: SignInRequest): Promise<void>;
}

export interface SignInRequest {
  /** Harness command, resolved again where the sign-in runs. */
  command: string;
  argv: readonly string[];
  environment: Record<string, string>;
  /** What the user is signing in to (`Hermes › nous`). */
  name: string;
}
