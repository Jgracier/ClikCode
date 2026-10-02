/** State shared by every account backend after a successful turn. */
import { publishLearnedUsage } from '../harness/accounts/usage-now.js';
import { recordAllowed, recordRefused } from '../harness/accounts/usage-learning.js';
import { clearQuotaMark, markQuotaExhausted } from '../harness/accounts/usage-reading.js';
import type { TurnUsage } from '../harness/protocol/turn-usage.js';
import { quotaRetryHint } from './failover.js';
import { recordInvocation } from './turn-output.js';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessState } from '../session/model.js';

export function recordSuccessfulAccountTurn(state: HarnessState, account: AiHarnessAccount, at: string): void {
  // The invocation must already be in state so the learned ceiling includes it.
  const when = Date.parse(at);
  account.usageLearning = recordAllowed(account.usageLearning, state.invocations, account.id, when);
  clearQuotaMark(account);
  account.verification = undefined;
  // A vendor figure already on the account stays. Learning fills in only when
  // that figure is missing or was an error.
  publishLearnedUsage(account, state, when);
}

export function recordQuotaRefusal(state: HarnessState, account: AiHarnessAccount, failure: unknown, now = Date.now()): void {
  markQuotaExhausted(account, now, quotaRetryHint(failure));
  account.usageLearning = recordRefused(account.usageLearning, state.invocations, account.id, now);
  publishLearnedUsage(account, state, now);
}

/** A clerk turn is a turn. Its cost raises the ceiling when the vendor allowed
 * it, and a quota refusal is the observation that places the limit. */
export function recordClerkTurn(state: HarnessState, account: AiHarnessAccount, turn: {
  sessionId: string; provider: string; model?: string | null; startedAt: number; usage?: TurnUsage; quota?: boolean; failure?: unknown;
}): void {
  if (turn.usage || !turn.quota) {
    recordInvocation(state, {
      sessionId: turn.sessionId, accountId: account.id, provider: turn.provider,
      ...(turn.model ? { model: turn.model } : {}), startedAt: turn.startedAt, ...(turn.usage ? { usage: turn.usage } : {}),
    });
  }
  if (turn.quota) recordQuotaRefusal(state, account, turn.failure);
  else recordSuccessfulAccountTurn(state, account, new Date().toISOString());
}
