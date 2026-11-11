/** A worker's approval request answered in a window: the answer goes back,
 * then -- for "tell it instead" -- the text, so it never overtakes the denial. */
import { approvalDecision } from '../harness/prompter.js';
import type { TerminalHarnessPrompter } from '../tui/prompter.js';

type ApprovalAsk = { id: string; title: string; detail?: string; preview?: import('../tui/render/approval-block.js').ApprovalPreview; rule?: string; callId?: string };

/** Asks in `rl`; `respond` sends the decision (synchronously, on the link the
 * told text then follows on). Withdrawn (`signal` aborted): nothing is sent. */
export async function answerWorkerApproval(
  rl: Pick<TerminalHarnessPrompter, 'approval' | 'markDrawn' | 'submitWaiting'>,
  request: ApprovalAsk, signal: AbortSignal, respond: (approved: boolean | 'always') => void,
): Promise<void> {
  const answer = await rl.approval(request.title, request.detail, request.preview, request.rule, signal, request.callId);
  if (signal.aborted) return;
  // Decided here: the row is drawn by this window, not again from a snapshot.
  rl.markDrawn(`outcome:${request.id}`);
  respond(approvalDecision(answer));
  if (typeof answer === 'object') rl.submitWaiting(answer.told, false);
}
