/** The note the agent is given, unseen, when a turn moves to another account (a spent plan, a refusal, a sign-in that failed):
 * who it left, why, and how much room the new account has. The person sees the same move as a line under the answer
 * (failover.ts accountSwitchLine); without this the model would carry on believing it is on the account it started with, and read
 * the earlier "limit reached" as its own. Written like the note a moved chat carries (resource-notes.ts withMoveNote): a resource
 * note at the front of the turn's text, so a vendor's copy of the turn read back is stripped of it. Pure: callers pass the usage
 * label they have (the cached reading, never a network call at the moment a turn is retrying). */
import type { AiHarnessAccount } from '../harness/definition.js';
import { cachedAccountUsageLabel } from '../harness/accounts/account-usage.js';
import type { HarnessSession, HarnessState } from '../session/model.js';
import { accountFailureReason, type AccountFailureKind } from './failover.js';
import { wrapResourceNote } from './resource-note-text.js';

export interface AccountSwitch { from: string; to: string; reason: string }

export function accountSwitchNoteText(change: AccountSwitch, usage?: string): string {
  const why = change.reason === 'quota-exhausted'
    ? `${change.from} ran out of usage`
    : `${change.from} failed (${accountFailureReason(change.reason as AccountFailureKind)})`;
  return `The account changed: ${why}, so this conversation continues on ${change.to}.`
    + (usage ? ` ${change.to} has ${usage}.` : '')
    + ` The conversation, files and tools are unchanged; a limit or error mentioned earlier was ${change.from}'s, not this account's.`;
}

/** `turnText` with the note in front, once: text that already carries it (a retry on the same account) is returned as it is. */
export function withAccountSwitchNote(turnText: string, change: AccountSwitch | undefined, usage?: string): string {
  if (!change) return turnText;
  const note = wrapResourceNote(accountSwitchNoteText(change, usage));
  return turnText.includes(note) ? turnText : `${note}\n\n${turnText}`;
}

/** A vendor turn: when it is on a different account than it started on (`session.pendingTurn.accountSwitch` is the move from the first
 * account to this one), its text carries the note, with this account's last known usage. Called before each attempt, so a retry whose
 * text was rebuilt from the user's request gets it again, and one that kept its text does not get it twice. */
export function noteAccountSwitch(ctx: { session: Pick<HarnessSession, 'pendingTurn'>; account: AiHarnessAccount; state: HarnessState; turnText: string }): void {
  const change = ctx.session.pendingTurn?.accountSwitch;
  if (!change) return;
  ctx.turnText = withAccountSwitchNote(ctx.turnText, change, cachedAccountUsageLabel(ctx.account, ctx.state));
}
