/** What a running turn may tell whoever is watching it -- and, in the one
 * case that blocks on an answer (approval), ask.
 *
 * TerminalHarnessPrompter satisfies this structurally, with no `implements`
 * needed: TypeScript checks the shape, not the declaration. That is
 * deliberate. drive.ts must never import the concrete class (a real TUI
 * renderer, ANSI painting and all) merely to type its own parameter -- a
 * worker's own broadcaster to attached remote clients satisfies the exact
 * same interface without being a terminal at all, or importing one.
 */
import type { HarnessActivityEvent } from '../harness/prompter.js';
import type { HarnessSession } from '../session/model.js';
import type { PlanEntry } from '../tui/render/plan-block.js';
import type { ApprovalPreview } from '../tui/render/approval-block.js';
import type { LiveTurnInputResult } from './live-input.js';

export interface TurnObserver {
  render(session: HarnessSession, account?: string, notice?: string): void;
  response(text: string, mode?: 'append' | 'replace'): void;
  activity(message: string): void;
  activityEvent(event: HarnessActivityEvent): void;
  phase(message: string): void;
  approval(title: string, detail?: string, preview?: ApprovalPreview, rule?: string): Promise<boolean | 'always'>;
  setPlan(entries: readonly PlanEntry[]): void;
  setTurnUsage(usage: { inputTokens?: number; outputTokens?: number }): void;
  startWaiting(
    message: string,
    onCancel?: (restoreDraft: boolean) => void,
    onSubmit?: (text: string) => Promise<LiveTurnInputResult>,
  ): void;
  stopWaiting(refresh?: boolean): void;
  suspend(): Promise<void>;
  resume(): void;
}
