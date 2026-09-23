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

export function preferredAccountId(
  state: HarnessState, provider: string, current?: string | null,
  where: (account: AiHarnessAccount) => boolean = () => true,
): string | null {
  const ready = state.accounts.filter((account) => account.provider === provider && account.status === 'ready' && where(account));
  if (!ready.length) return null;
  if (current && ready.some((account) => account.id === current)) return current;
  const lastUsed = [...state.sessions]
    .filter((session) => session.accountId && ready.some((account) => account.id === session.accountId))
    .sort((left, right) => Date.parse(right.updatedAt ?? '') - Date.parse(left.updatedAt ?? ''))[0]?.accountId;
  return lastUsed ?? ready[0]!.id;
}
