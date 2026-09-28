/** State shared by every account backend after a successful turn. */
import { recordAllowed, recordRefused } from '../harness/accounts/usage-learning.js';
import { clearQuotaMark, markQuotaExhausted } from '../harness/accounts/usage-reading.js';
import { quotaRetryHint } from './failover.js';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessState } from '../session/model.js';

export function recordSuccessfulAccountTurn(state: HarnessState, account: AiHarnessAccount, at: string): void {
  // The invocation must already be in state so the learned ceiling includes it.
  account.usageLearning = recordAllowed(account.usageLearning, state.invocations, account.id, Date.parse(at));
  clearQuotaMark(account);
  account.verification = undefined;
}

export function recordQuotaRefusal(state: HarnessState, account: AiHarnessAccount, failure: unknown, now = Date.now()): void {
  markQuotaExhausted(account, now, quotaRetryHint(failure));
  account.usageLearning = recordRefused(account.usageLearning, state.invocations, account.id, now);
}
