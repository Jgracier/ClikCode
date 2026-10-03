/** What a turn's outcome records on its account. */
import { clearQuotaMark, markQuotaExhausted, vendorWindows, windowSpent } from '../harness/accounts/usage-reading.js';
import { noteAllowedTurn, noteRefusal } from '../harness/accounts/learned-usage.js';
import type { TurnUsage } from '../harness/protocol/turn-usage.js';
import { quotaRetryHint } from './failover.js';
import { recordInvocation } from './turn-output.js';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessState } from '../session/model.js';

type Invocation = HarnessState['invocations'][number];

/** A turn the vendor allowed, already in the invocation log. */
export function recordSuccessfulAccountTurn(state: HarnessState, account: AiHarnessAccount, invocation: Invocation): void {
  clearQuotaMark(account);
  account.verification = undefined;
  noteAllowedTurn(state, account, invocation);
}

/** A refusal holds until the vendor says it ends: the refusal's own "resets
 * in", else the reset of a window its last reading showed spent, else --
 * for a harness that reports no usage -- when what has been learned says,
 * else the default (see quotaMarkExpiresAt). */
export function recordQuotaRefusal(state: HarnessState, account: AiHarnessAccount, failure: unknown, now = Date.now()): void {
  const named = quotaRetryHint(failure, now);
  const spentReset = vendorWindows(account)
    .filter((window) => windowSpent(window) && window.resetsAt !== undefined && Date.parse(window.resetsAt) > now)
    .map((window) => window.resetsAt!).sort().at(-1);
  const learnedReset = noteRefusal(state, account, now, named);
  markQuotaExhausted(account, now, named ?? spentReset ?? learnedReset);
}

/** A clerk turn is a turn: recorded, and its refusal marks the account. */
export function recordClerkTurn(state: HarnessState, account: AiHarnessAccount, turn: {
  sessionId: string; provider: string; model?: string | null; startedAt: number; usage?: TurnUsage; quota?: boolean; failure?: unknown;
}): void {
  const invocation = turn.usage || !turn.quota
    ? recordInvocation(state, {
      sessionId: turn.sessionId, accountId: account.id, provider: turn.provider,
      ...(turn.model ? { model: turn.model } : {}), startedAt: turn.startedAt, ...(turn.usage ? { usage: turn.usage } : {}),
    })
    : undefined;
  if (turn.quota) recordQuotaRefusal(state, account, turn.failure);
  else if (invocation) recordSuccessfulAccountTurn(state, account, invocation);
}
