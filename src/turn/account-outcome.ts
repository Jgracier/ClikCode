/** What a turn's outcome records on its account. */
import { clearQuotaMark, markQuotaExhausted, vendorWindows, windowSpent } from '../harness/accounts/usage-reading.js';
import type { TurnUsage } from '../harness/protocol/turn-usage.js';
import { quotaRetryHint } from './failover.js';
import { recordInvocation } from './turn-output.js';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessState } from '../session/model.js';

export function recordSuccessfulAccountTurn(account: AiHarnessAccount): void {
  clearQuotaMark(account);
  account.verification = undefined;
}

/** A refusal holds until the vendor says it ends: the refusal's own "resets
 * in", else the reset of a window its last reading showed spent, else the
 * default (see quotaMarkExpiresAt). */
export function recordQuotaRefusal(account: AiHarnessAccount, failure: unknown, now = Date.now()): void {
  const spentReset = vendorWindows(account)
    .filter((window) => windowSpent(window) && window.resetsAt !== undefined && Date.parse(window.resetsAt) > now)
    .map((window) => window.resetsAt!).sort().at(-1);
  markQuotaExhausted(account, now, quotaRetryHint(failure) ?? spentReset);
}

/** A clerk turn is a turn: recorded, and its refusal marks the account. */
export function recordClerkTurn(state: HarnessState, account: AiHarnessAccount, turn: {
  sessionId: string; provider: string; model?: string | null; startedAt: number; usage?: TurnUsage; quota?: boolean; failure?: unknown;
}): void {
  if (turn.usage || !turn.quota) {
    recordInvocation(state, {
      sessionId: turn.sessionId, accountId: account.id, provider: turn.provider,
      ...(turn.model ? { model: turn.model } : {}), startedAt: turn.startedAt, ...(turn.usage ? { usage: turn.usage } : {}),
    });
  }
  if (turn.quota) recordQuotaRefusal(account, turn.failure);
  else recordSuccessfulAccountTurn(account);
}
