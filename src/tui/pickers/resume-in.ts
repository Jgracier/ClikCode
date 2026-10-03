/** "Resume in": every account on this chat's harness is out of usage, so the
 * chat continues on another harness that still has some.
 *
 * Failover only ever moves between accounts of one harness. When the last of
 * them runs out, the chat used to stop at "All accounts exhausted" and the
 * user had to know that `/<harness>` would carry it elsewhere. This offers
 * the harnesses with an account that has usage left, then that harness's
 * models; choosing a model hands the conversation over (the same branch
 * `/<harness>` makes) and the caller resends the message that ran out. */

import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../../harness/definition.js';
import type { HarnessPrompter, PickerOption } from '../../harness/prompter.js';
import { nativeModelCatalogForPicker } from '../../harness/accounts/model-catalog.js';
import { allLocalHarnesses, harnessCanRunTurns, harnessTierRank } from '../../runtime/lazy-bridge.js';
import { readState } from '../../session/state/read.js';
import { moveQueuedTurns, newProviderConversation, takeQueuedMessages } from '../../commands/ai/conversations.js';
import { preferredAccountId } from '../../commands/ai/preferred-account.js';
import { INTERRUPTED_TURN_REQUEST } from '../../turn/failover-prompt.js';
import { nextQuotaReset, quotaResetPhrase } from '../../turn/usage-exhausted.js';
import { chooseOption } from './choose.js';
import { accountCanTakeTurn } from '../../harness/accounts/usage-reading.js';
import { turnBackendForAccount } from '../../turn/account-routing.js';
import type { HarnessSession } from '../../session/model.js';

/** An account that can take a turn now -- the one rule failover uses too. */
export function accountHasUsage(account: AiHarnessAccount): boolean {
  return accountCanTakeTurn(account);
}

/** Whether an account of the chat's own provider can take the turn. While
 * one can, the same-provider switch is the one to make, not another provider. */
export function sessionProviderHasUsage(accounts: readonly AiHarnessAccount[], provider: string | null | undefined): boolean {
  return accounts.some((account) => account.provider === provider && turnBackendForAccount(account) === 'vendor' && accountHasUsage(account));
}

export async function sameProviderCanTakeTurn(id: string): Promise<boolean> {
  const state = await readState({ transcripts: [id] });
  const session = state.sessions.find((item) => item.id === id);
  return session ? sessionProviderHasUsage(state.accounts, session.provider) : false;
}

/** Harnesses other than `current` with an account that has usage, best
 * tier first, each with those accounts. */
export function resumeInCandidates(
  harnesses: readonly AiLocalHarnessDefinition[], accounts: readonly AiHarnessAccount[], current: string | undefined,
  rank: (harness: AiLocalHarnessDefinition) => number,
): { harness: AiLocalHarnessDefinition; accounts: AiHarnessAccount[] }[] {
  return harnesses
    .filter((harness) => harness.command !== current)
    .map((harness) => ({ harness, accounts: accounts.filter((account) => account.provider === harness.provider && accountHasUsage(account)) }))
    .filter((candidate) => candidate.accounts.length > 0)
    .sort((left, right) => rank(left.harness) - rank(right.harness) || left.harness.displayName.localeCompare(right.harness.displayName));
}

/** Returns the new conversation's id, or undefined when there is nowhere to
 * go or the user backs out (the chat then stays as it was). */
export async function interactiveResumeInPicker(rl: HarnessPrompter, id: string, prompt: string): Promise<{ id: string; prompt: string } | undefined> {
  // Index for every chat's last model; this chat's transcript is not needed
  // to list other harnesses with usage left.
  const state = await readState({ transcripts: [] });
  const session = state.sessions.find((item) => item.id === id);
  if (!session) return undefined;
  // Another provider is the answer only when this one has nothing left.
  if (sessionProviderHasUsage(state.accounts, session.provider)) return undefined;
  const candidates = resumeInCandidates(allLocalHarnesses().filter(harnessCanRunTurns), state.accounts, session.nativeHarness, harnessTierRank);
  if (!candidates.length) return undefined;
  const spent = state.accounts.filter((account) => account.provider === session.provider);
  const reset = nextQuotaReset(spent);
  const title = `All accounts exhausted${reset ? ` · back ${quotaResetPhrase(reset)}` : ''} — resume in`;
  for (;;) {
    const command = await chooseOption(rl, title, candidates.map(({ harness, accounts }): PickerOption<string> => ({
      label: harness.displayName,
      detail: `· ${accounts.slice(0, 2).map((account) => account.label).join(', ')}${accounts.length > 2 ? ` +${accounts.length - 2}` : ''}`,
      value: harness.command,
    })));
    const chosen = candidates.find((candidate) => candidate.harness.command === command);
    if (!chosen) return undefined;
    const accountId = preferredAccountId(state, chosen.harness.provider, null,
      (candidate) => chosen.accounts.some((account) => account.id === candidate.id));
    const account = chosen.accounts.find((candidate) => candidate.id === accountId)!;
    const catalog = await nativeModelCatalogForPicker(chosen.harness, account);
    const lastUsedModel = [...state.sessions]
      .filter((item) => item.nativeHarness === chosen.harness.command && item.model)
      .sort((left, right) => Date.parse(right.updatedAt ?? '') - Date.parse(left.updatedAt ?? ''))[0]?.model;
    const model = lastUsedModel ?? state.providerSettings[chosen.harness.provider]?.model ?? catalog.configured ?? null;
    return continueIn(id, chosen.harness, account.id, model, prompt);
  }
}

async function continueIn(
  id: string, harness: AiLocalHarnessDefinition, accountId: string, model: string | null, prompt: string,
): Promise<{ id: string; prompt: string }> {
  // The branch carries the interrupted request and all progress recorded for
  // it. Asking the new provider to continue avoids running that request a
  // second time and preserves the partial answer and tool activity.
  const nextPrompt = await interruptedTurnResumePrompt(id, prompt);
  const nextId = await newProviderConversation(id, harness.command, { accountId, model });
  return { id: nextId, prompt: nextPrompt };
}

export async function interruptedTurnResumePrompt(id: string, prompt: string): Promise<string> {
  // The interrupted turn is kept in the conversation's transcript file: read
  // without it there was never a pending turn, the original words were sent
  // again, and the branch -- which carries that turn -- ran the request twice.
  const state = await readState({ transcripts: [id] });
  const pending = state.sessions.find((item) => item.id === id)?.pendingTurn;
  return resumePromptForPendingTurn(pending, prompt);
}

export function resumePromptForPendingTurn(pending: HarnessSession['pendingTurn'], prompt: string): string {
  return pending?.prompt === prompt ? INTERRUPTED_TURN_REQUEST : prompt;
}

/** What carries a turn on after it ran out of usage on every account:
 *  - `retry`: an account of this provider got its quota back after failover
 *    looked, so the turn goes again here, once;
 *  - `moved`: "Resume in" branched the conversation to another provider,
 *    with what was queued behind the turn;
 *  - `stayed`: nothing carried it on; `queued` are the messages that were
 *    typed behind it, taken back for the composer when nothing here could
 *    run them (each would fail the same way and offer this again). */
export type ExhaustedTurnNext =
  | { retry: string }
  | { moved: { id: string; prompt: string } }
  | { stayed: string[] };

/** The same-provider retry is at most once per interrupted turn. It is keyed
 * on what was SENT, in the conversation it was sent in: the retry sends the
 * continuation, not the original words, so keying on the original let the
 * continuation's own exhaustion retry a second time. */
export interface ExhaustionRetryGuard { autoResent?: string }

export async function carryOnAfterExhaustion(
  rl: HarnessPrompter, id: string, prompt: string, guard: ExhaustionRetryGuard,
): Promise<ExhaustedTurnNext> {
  const sent = (text: string): string => `${id}\n${text}`;
  if (guard.autoResent !== sent(prompt) && await sameProviderCanTakeTurn(id)) {
    const continuation = await interruptedTurnResumePrompt(id, prompt);
    guard.autoResent = sent(continuation);
    return { retry: continuation };
  }
  const moved = await interactiveResumeInPicker(rl, id, prompt);
  if (moved) {
    await moveQueuedTurns(id, moved.id);
    return { moved };
  }
  return { stayed: await sameProviderCanTakeTurn(id) ? [] : await takeQueuedMessages(id) };
}
