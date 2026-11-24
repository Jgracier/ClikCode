/** Models a vendor refused to run on one account: "The 'gpt-5.3-codex-spark'
 * model is not supported when using Codex with a ChatGPT account" (Pi through
 * a ChatGPT sign-in, 2026-11-24), a plan's ACP list leaving the model out.
 *
 * Evidence about the account, not the model: another account of the same
 * vendor may run it, so a refusal steers only this account -- the model it
 * starts on (resolveNativeModel) and whether failover offers it this model.
 * The vendor's model list is replaced on every discovery (syncAccountModels),
 * so the refusal is kept apart from it, and it lapses: plans change. */
import type { AiHarnessAccount } from '../definition.js';

/** How long one refusal holds before the model is offered to the account again. */
export const MODEL_REFUSAL_HOLD_MS = 7 * 24 * 60 * 60 * 1000;

export function accountRefusesModel(account: Pick<AiHarnessAccount, 'refusedModels'> | undefined, model: string | null | undefined, now = Date.now()): boolean {
  const at = model ? account?.refusedModels?.[model] : undefined;
  return Boolean(at && now - Date.parse(at) < MODEL_REFUSAL_HOLD_MS);
}

/** Records the vendor's refusal of `model` on `account`; lapsed entries go. */
export function recordModelRefusal(account: AiHarnessAccount, model: string, now = Date.now()): void {
  const kept = Object.entries(account.refusedModels ?? {}).filter(([, at]) => now - Date.parse(at) < MODEL_REFUSAL_HOLD_MS);
  account.refusedModels = { ...Object.fromEntries(kept), [model]: new Date(now).toISOString() };
}

/** A turn the vendor served on `model` here: whatever refused it before no longer does. */
export function clearModelRefusal(account: AiHarnessAccount, model: string | null | undefined): void {
  if (!model || !account.refusedModels?.[model]) return;
  const { [model]: _gone, ...rest } = account.refusedModels;
  if (Object.keys(rest).length) account.refusedModels = rest;
  else delete account.refusedModels;
}
