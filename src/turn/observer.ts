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
import type { TurnMarkJournal } from './turn-marks.js';

export interface TurnObserver {
  render(session: HarnessSession, account?: string, notice?: string): void;
  response(text: string, mode?: 'append' | 'replace'): void;
  activity(message: string): void;
  activityEvent(event: HarnessActivityEvent): void;
  phase(message: string): void;
  approval(title: string, detail?: string, preview?: ApprovalPreview, rule?: string, signal?: AbortSignal, callId?: string): Promise<boolean | 'always'>;
  /** A vendor's question (options, several questions, free text). Absent where
   * the surface cannot ask: the turn then cancels the question with a notice. */
  askQuestions?(request: import('../harness/events/question.js').HarnessQuestionRequest, signal?: AbortSignal): Promise<import('../harness/events/question.js').HarnessQuestionResult>;
  setPlan(entries: readonly PlanEntry[]): void;
  setTurnUsage(usage: TurnUsage): void;
  /** Background agents the vendor says are still running (the level, 0 =
   * none): the turn's end says `Waiting for N background agents` from it.
   * Optional: a surface that draws the end line from the saved turn alone
   * has nothing to do with it live. */
  setPendingBackground?(pending: number): void;
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
  /** The turn's journal exists now: send it the turn's thoughts, plan,
   * notices and approval outcomes, and number rows from its counter, so what
   * is shown and what is saved agree (turn-marks.ts). Optional: a surface
   * that keeps no copy of its own has nothing to hand over. */
  bindJournal?(journal: TurnMarkJournal | undefined): void;
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
