/** Which account a new or re-pointed session should use for a provider.
 *
 * Its own module because three callers need it -- sessions.ts, harness.ts and
 * conversations.ts -- while sessions.ts imports newConversationSession from
 * conversations.ts. Living in sessions.ts therefore made all three import
 * each other. A helper every sibling needs does not belong in whichever
 * sibling happened to define it first.
 */

import type { AiHarnessAccount } from '../../harness/definition.js';
import type { HarnessState } from '../../session/model.js';
import { accountCanTakeTurn, accountQuotaSpent } from '../../harness/accounts/usage-reading.js';

export function preferredAccountId(
  state: HarnessState, provider: string, current?: string | null,
  where: (account: AiHarnessAccount) => boolean = () => true,
): string | null {
  const ready = state.accounts.filter((account) => account.provider === provider
    && accountCanTakeTurn(account) && where(account));
  if (!ready.length) return null;
  if (current && ready.some((account) => account.id === current)) return current;
  const lastUsed = [...state.sessions]
    .filter((session) => session.accountId && ready.some((account) => account.id === session.accountId))
    .sort((left, right) => Date.parse(right.updatedAt ?? '') - Date.parse(left.updatedAt ?? ''))[0]?.accountId;
  return lastUsed ?? ready[0]!.id;
}

/** The account a provider switch lands on. Usable accounts first (quota
 * left, no verification pending): the session's own, then the one used last,
 * then any. With none usable, still a signed-in one, best first. Signed in is
 * what decides whether to ask the user to log in -- an account out of quota
 * or waiting on the vendor's verification is still one they have, and its
 * turn says why it cannot run. Null only when the provider has no signed-in
 * account at all, the one case a sign-in is the answer to. */
export function signedInAccountId(
  state: HarnessState, provider: string, current?: string | null,
  where: (account: AiHarnessAccount) => boolean = () => true,
): string | null {
  const signedIn = state.accounts.filter((account) => account.provider === provider && account.status === 'ready' && where(account));
  if (!signedIn.length) return null;
  const usable = signedIn.filter((account) => accountCanTakeTurn(account));
  const pool = usable.length ? usable : signedIn;
  if (current && pool.some((account) => account.id === current)) return current;
  const lastUsed = [...state.sessions]
    .filter((session) => session.accountId && pool.some((account) => account.id === session.accountId))
    .sort((left, right) => Date.parse(right.updatedAt ?? '') - Date.parse(left.updatedAt ?? ''))[0]?.accountId;
  if (lastUsed) return lastUsed;
  const rank = (account: AiHarnessAccount): number => (accountQuotaSpent(account) ? 2 : 0) + (account.verification ? 1 : 0);
  return [...pool].sort((left, right) => rank(left) - rank(right))[0]!.id;
}
