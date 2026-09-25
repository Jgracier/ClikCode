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
import { newProviderConversation } from '../../commands/ai/conversations.js';
import { preferredAccountId } from '../../commands/ai/preferred-account.js';
import { discardInterruptedTurn } from '../../turn/runtime.js';
import { nextQuotaReset, quotaResetPhrase } from '../../turn/usage-exhausted.js';
import { chooseOption } from './choose.js';
import { modelRow } from './model.js';

/** An account that can take a turn now. */
export function accountHasUsage(account: AiHarnessAccount): boolean {
  return account.status === 'ready' && account.quotaState !== 'exhausted' && !account.verification;
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
export async function interactiveResumeInPicker(rl: HarnessPrompter, id: string, prompt: string): Promise<string | undefined> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) return undefined;
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
    const current = catalog.configured;
    const models = [...catalog.models].sort((left, right) => left === current ? -1 : right === current ? 1 : left.localeCompare(right));
    // No models published: the harness runs its own default, nothing to ask.
    const model = models.length
      ? await chooseOption(rl, `${chosen.harness.displayName} — choose a model`, models.map((item) => modelRow(chosen.harness, catalog, item, current)))
      : null;
    if (model === undefined) continue; // back to the harness list
    return continueIn(id, chosen.harness, account.id, model, prompt);
  }
}

async function continueIn(
  id: string, harness: AiLocalHarnessDefinition, accountId: string, model: string | null, prompt: string,
): Promise<string> {
  // The message that ran out is sent again on the new harness; it must not
  // also ride along in the history the branch carries.
  await discardInterruptedTurn(id, prompt);
  return newProviderConversation(id, harness.command, { accountId, model });
}
