/**
 * What a user is told when there is no quota left anywhere.
 *
 * Every harness reaches this the same way -- the last account it could try
 * refused the turn -- so every harness says the same thing, in the same words,
 * whatever the vendor's own error happened to be ("Payment Required",
 * "usage limit reached", "quota exhausted").
 *
 * One sentence, for every harness:
 *
 *   All accounts exhausted
 *
 * The composer rule already says when a window comes back, and "Out Of Credits"
 * for a balance. This line only says that none of the accounts left can take
 * the turn. It is not an error.
 */
import { quotaResetPhrase } from '../harness/protocol/format.js';
import type { AiHarnessAccount } from '../harness/definition.js';
import { accountCanTakeTurn, windowSpent, type AccountUsageReading, type UsageWindow } from '../harness/accounts/usage-reading.js';

/** The soonest a spent window comes back, across every account that was
 * tried -- or the reset a refusal named (`quotaRetryAt`, the vendor's "try
 * again in"). Undefined when nothing on offer has a reset -- a spent
 * balance, or a vendor that never said. */
export function nextQuotaReset(
  accounts: readonly AiHarnessAccount[], now: number = Date.now(),
): Date | undefined {
  const resets = accounts
    .flatMap((account) => [
      ...(((account.usage as AccountUsageReading | undefined)?.windows ?? []) as readonly UsageWindow[])
        .filter((window) => windowSpent(window) && window.resetsAt !== undefined)
        .map((window) => window.resetsAt!),
      ...(account.quotaState === 'exhausted' && account.quotaRetryAt ? [account.quotaRetryAt] : []),
    ])
    .map((at) => Date.parse(at))
    .filter((at) => Number.isFinite(at) && at > now)
    .sort((left, right) => left - right);
  return resets.length ? new Date(resets[0]!) : undefined;
}

/** The one sentence shown when every account has been tried and none has
 * quota left. The same words for every harness. The reset time, when there
 * is one, stays on the composer rule rather than in this sentence. */
export function usageExhaustedMessage(
  _accounts: readonly AiHarnessAccount[], _now: number = Date.now(),
): string {
  return 'All accounts exhausted';
}

/** Whether a failure message is one ClikCode composed itself, rather than a
 * vendor's or a crash's.
 *
 * Prefixing this with "Error:" reads as though something broke, when running
 * out of quota is an ordinary outcome. Older wordings are still recognized
 * so a message already on screen is not relabeled. */
export function isUsageExhaustedMessage(message: string): boolean {
  return /^(?:All accounts exhausted|Usage Exhausted|Credits Exhausted)\b/.test(message.trim());
}

/** A turn parked until its provider's quota comes back (HarnessSession
 * `resumeAt`): `at` is the reset, `prompt` what to send then -- the
 * continuation of the interrupted turn, or the line when it never started.
 * On the session, so a closed window or a restarted worker does not lose it;
 * the conversation's worker sends it (worker/resume-wait.ts). */
export interface ResumeAt { at: string; prompt: string; setAt: string }

/** Longest single sleep before looking again: a laptop that slept through the
 * reset is noticed within this, and so is a cancel written by another build. */
export const RESUME_MAX_SLEEP_MS = 10 * 60_000;
/** Past the reset, how often to look for an account whose reading came back. */
export const RESUME_RECHECK_MS = 60_000;
/** Past the reset with still no account able to take the turn: stop waiting. */
export const RESUME_GRACE_MS = 60 * 60_000;

/** What a parked turn does now: sleep, send it, or stop waiting. Sent once
 * the reset has passed AND an account of the chat's own provider can take the
 * turn -- the same rule failover asks (accountCanTakeTurn). */
export function resumeStep(
  resumeAt: ResumeAt, accounts: readonly AiHarnessAccount[], provider: string | null | undefined, now: number = Date.now(),
): { wait: number } | 'send' | 'give-up' {
  const at = Date.parse(resumeAt.at);
  if (!Number.isFinite(at)) return 'give-up';
  if (now < at) return { wait: Math.min(at - now, RESUME_MAX_SLEEP_MS) };
  if (accounts.some((account) => account.provider === provider && accountCanTakeTurn(account, now))) return 'send';
  return now - at >= RESUME_GRACE_MS ? 'give-up' : { wait: RESUME_RECHECK_MS };
}

/** `waiting for reset · 5:34PM` -- the board row and the status line. */
export function resumeWaitLabel(resumeAt: Pick<ResumeAt, 'at'>, now: number = Date.now()): string {
  return `waiting for reset · ${quotaResetPhrase(new Date(resumeAt.at), now)}`;
}
