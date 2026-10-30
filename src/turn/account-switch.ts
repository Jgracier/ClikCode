/** The one account-failover decision a turn makes after an attempt failed on
 * its account: classify the failure, mark the account (account-outcome, via
 * accounts.after), choose the next usable account (account-routing), say the
 * switch before the retry, record it, and log it.
 *
 * Shared by the vendor and direct backends. What only a vendor does between
 * choosing and recording (closing its process, carrying the thread, taking up
 * a standby) is its `carry` step. */
import type { AiHarnessAccount } from '../harness/definition.js';
import { lifecycle } from '../runtime/lifecycle-log.js';
import type { AccountFailureKind } from './failover.js';
import { classifyTurnFailure } from './account-evidence.js';

/** The two steps of a turn's accounts (account-routing.ts turnAccounts) a switch uses. */
interface FailoverAccounts {
  after(failure: unknown, kind: AccountFailureKind, signal?: AbortSignal): Promise<AiHarnessAccount>;
  switchTo(to: AiHarnessAccount, why: AccountFailureKind): Promise<void>;
}

/** What `carry` reports for the lifecycle line: closeMs/carryMs are subtracted
 * from the recording time; the rest is logged as given. */
interface CarryReport<T> { value: T; fields?: { closeMs?: number; carryMs?: number; [field: string]: unknown } }

export async function switchAccountAfterFailure<T = undefined>(input: {
  accounts: FailoverAccounts;
  from: AiHarnessAccount;
  failure: unknown;
  /** Already classified by a caller that read more than the error (a vendor). */
  kind?: AccountFailureKind;
  signal?: AbortSignal;
  /** The `harness` of the lifecycle line. */
  harness: string;
  /** Runs once the next account is chosen, before it is recorded. `elapsed`
   * is the milliseconds since the switch began, `chooseMs` its choosing share. */
  carry?: (to: AiHarnessAccount, timing: { switchAt: number; chooseMs: number }) => Promise<CarryReport<T>>;
}): Promise<{ to: AiHarnessAccount; kind: AccountFailureKind; value: T | undefined }> {
  const kind = input.kind ?? classifyTurnFailure(input.failure);
  const switchAt = Date.now();
  const to = await input.accounts.after(input.failure, kind, input.signal);
  const chooseMs = Date.now() - switchAt;
  const carried = await input.carry?.(to, { switchAt, chooseMs });
  await input.accounts.switchTo(to, kind);
  const fields = carried?.fields ?? {};
  lifecycle('worker.switch', {
    harness: input.harness, from: input.from.id.slice(0, 8), to: to.id.slice(0, 8), why: kind,
    chooseMs, ...fields,
    recordMs: Date.now() - switchAt - chooseMs - (fields.closeMs ?? 0) - (fields.carryMs ?? 0),
  });
  return { to, kind, value: carried?.value };
}
