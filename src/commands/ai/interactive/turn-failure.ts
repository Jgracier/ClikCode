/** Deciding what a failed turn changes about the loop. */
import { lifecycle } from '../../../runtime/lifecycle-log.js';
import chalk from 'chalk';
import { isUsageExhaustedMessage, nextQuotaReset } from '../../../turn/usage-exhausted.js';
import { quotaResetPhrase } from '../../../harness/protocol/format.js';
import { FAILURE_NOTE_LIMIT, failureLine } from '../../../harness/protocol/stderr-line.js';
import type { HarnessSession, HarnessState } from '../../../session/model.js';
import { readState } from '../../../session/state/read.js';
import { emitHarnessOutput } from '../../../harness/output.js';
import { TerminalHarnessPrompter } from '../../../tui/prompter.js';
import { afterTurnFailure } from '../../../session/attach.js';
import { signInOutcomeSaid } from '../../account.js';
import type { ExhaustionRetryGuard } from '../../../tui/pickers/resume-in.js';
import { refreshSessionWorker } from '../../../worker/turn-bridge.js';

/** What a failed turn changes about the loop: a notice to show, a message to send next, or the conversation it moved to. */
interface TurnFailureEffect { notice?: string; resend?: string; id?: string }

interface FailureContext {
  terminal: TerminalHarnessPrompter | undefined;
  id: string;
  guard: ExhaustionRetryGuard;
  refreshUsage: (target: HarnessSession, targetState: HarnessState, afterTurn?: boolean) => void;
}

/** A turn failed (see afterTurnFailure): one this window submitted, or one
 * it was only following -- most often "All accounts exhausted" from a
 * worker this window did not drive; left uncaught that crashed the loop
 * merely for reopening the chat. Running out is not shown behind an
 * "Error:". Carried on, the next pass sends `resend` (or, with none, follows
 * the turn another window carried on). */
export async function turnFailureEffect(
  { terminal, id, guard, refreshUsage }: FailureContext, error: unknown, failed: { line?: string; sent?: string; queuedTurnId?: string },
): Promise<TurnFailureEffect> {
  const message = error instanceof Error ? error.message : String(error);
  // The whole vendor text is for `clikcode logs`; the screen gets one line.
  lifecycle('window.turn.error', { message: message.slice(0, 8000) });
  // Keep the submitted message visible when there's an error, so the user sees what failed
  // (don't clear it like we would for a turn that never started properly)
  // A sign-in that did not sign in has said so in its own line.
  if (signInOutcomeSaid(error)) return {};
  // The worker put its line in the turn already.
  const said = Boolean((error as { said?: boolean } | undefined)?.said);
  const next = await afterTurnFailure(terminal, id, error, { ...failed, guard });
  // A stopped turn ends on its own "Stopped" row; nothing more is said.
  if (next.cancelled && terminal) return {};
  if (!terminal) { emitHarnessOutput({ panel: 'error', message: failureLine(message) }); return {}; }
  if ('retry' in next) return { resend: next.retry };
  if ('moved' in next) return { id: next.moved.id, resend: next.moved.prompt };
  if (next.waiting) {
    // The worker sends it at the reset; it hears of the parked turn now.
    // The status line says it is waiting: nothing more is drawn.
    refreshSessionWorker(id);
    const parkedState = await readState({ transcripts: [] });
    const parked = parkedState.sessions.find((item) => item.id === id);
    if (parked) refreshUsage(parked, parkedState);
    return {};
  }
  // Running out says when usage is back, as the Resume-in list did.
  if (next.back.length) terminal?.restoreDraft(next.back.join('\n\n'));
  if (said) return {};
  const notice = isUsageExhaustedMessage(message) ? `${message}${await usageBackPhrase(id)}` : chalk.red(`Error: ${failureLine(message, FAILURE_NOTE_LIMIT)}`);
  return { notice };
}

/** ` · back 11:11PM`: when the conversation's provider has usage again,
 * where an account says; empty when none does. */
async function usageBackPhrase(chat: string): Promise<string> {
  const state = await readState({ transcripts: [] });
  const provider = state.sessions.find((item) => item.id === chat)?.provider;
  const reset = provider ? nextQuotaReset(state.accounts.filter((account) => account.provider === provider)) : undefined;
  return reset ? ` · back ${quotaResetPhrase(reset)}` : '';
}
