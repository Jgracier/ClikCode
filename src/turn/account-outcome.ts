/** State shared by every account backend after a successful turn. */
import { recordAllowed } from '../harness/accounts/usage-learning.js';
import { clearQuotaMark } from '../harness/accounts/usage-reading.js';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessState } from '../session/model.js';

export function recordSuccessfulAccountTurn(state: HarnessState, account: AiHarnessAccount, at: string): void {
  // The invocation must already be in state so the learned ceiling includes it.
  account.usageLearning = recordAllowed(account.usageLearning, state.invocations, account.id, Date.parse(at));
  clearQuotaMark(account);
  account.verification = undefined;
}
