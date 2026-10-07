/** What a turn's outcome records on its account. */
import { clearQuotaMark, markQuotaExhausted, vendorWindows, windowSpent } from '../harness/accounts/usage-reading.js';
import { noteAllowedTurn, noteRefusal } from '../harness/accounts/learned-usage.js';
import type { TurnUsage } from '../harness/protocol/turn-usage.js';
import { quotaRetryHint, quotaRollingWindowMs } from './failover.js';
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

/** A free-plan refusal can arrive before the billing probe has named the
 * plan. Without that, the refusal is not learned and the status line never
 * leaves "Free plan". */
function noteFreePlan(account: AiHarnessAccount, failure: unknown): void {
  if (account.plan) return;
  const carried = (failure ?? {}) as { stderrTail?: unknown; message?: unknown };
  const text = [carried.stderrTail, carried.message].filter((part): part is string => typeof part === 'string').join('\n');
  if (/free-usage-exhausted/i.test(text)) account.plan = { name: 'Free' };
}

/** A refusal holds until the vendor says it ends: the refusal's own "resets
 * in", else the reset of a window its last reading showed spent, else --
 * for a harness that reports no usage -- when what has been learned says.
 * A rolling window names its length, not an instant, so the learned age-out
 * is the reset and the whole window is only the fallback. With none of
 * those, the mark uses the default (see quotaMarkExpiresAt). */
export function recordQuotaRefusal(state: HarnessState, account: AiHarnessAccount, failure: unknown, now = Date.now()): void {
  noteFreePlan(account, failure);
  const named = quotaRetryHint(failure, now);
  // A rolling window names its length. Passing that as a reset instant makes
  // the learner reject it: the window ends when the oldest spend ages out,
  // not a full length from now.
  const windowMs = quotaRollingWindowMs(failure);
  const exact = windowMs ? undefined : named;
  const spentReset = vendorWindows(account)
    .filter((window) => windowSpent(window) && window.resetsAt !== undefined && Date.parse(window.resetsAt) > now)
    .map((window) => window.resetsAt!).sort().at(-1);
  const learnedReset = noteRefusal(state, account, now, exact, windowMs);
  markQuotaExhausted(account, now, exact ?? spentReset ?? learnedReset ?? named);
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
