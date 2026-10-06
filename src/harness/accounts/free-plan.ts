/** Which of an account's models its vendor's free plan runs. Nothing here
 * names a model: each fact is the vendor's own, read where it publishes it
 * (catalog `freePlan` says only where to look).
 *
 * - A `:free` id is free everywhere it appears (OpenRouter's convention,
 *   which Cline, Kilo, Hermes's Nous and every OpenRouter route share).
 * - The vendor's list marks it (`catalog.free`: Kilo's `isFree`, OpenCode's
 *   zero price).
 * - The account is on a free plan (`account.plan`, from its usage reading)
 *   and either the vendor named that plan's models (Cursor: the ones it does
 *   not file as "named", i.e. Auto) or lists only what the plan runs
 *   (`freePlan.listed`: Codex, Grok, Copilot, Kiro, Devin, Antigravity). */

import type { AiHarnessAccount, AiLocalHarnessDefinition, ModelCatalogResult } from '../definition.js';

/** A plan the vendor itself calls free. Every vendor read so far says so in
 * its plan's name ("Free", "KIRO FREE", "free_limited_copilot", "free-tier",
 * "TEAMS_TIER_DEVIN_FREE", "Free Plan"); none of their paid plans does. */
export function planIsFree(plan: AiHarnessAccount['plan'] | undefined): boolean {
  return Boolean(plan && /free/i.test(plan.name));
}

/** A vendor's model id without its settings: Cursor's `default[]` and
 * `composer-2.5[fast=true]` are its plan's `default` and `composer-2.5`. */
function baseModel(model: string): string {
  return model.replace(/\[[^\]]*\]$/, '');
}

export function freePlanModels(
  harness: Pick<AiLocalHarnessDefinition, 'freePlan'> | undefined,
  account: Pick<AiHarnessAccount, 'plan'> | undefined,
  catalog: Pick<ModelCatalogResult, 'models' | 'free'>,
): Set<string> {
  const free = new Set(catalog.free ?? []);
  for (const model of catalog.models) if (model.endsWith(':free')) free.add(model);
  if (planIsFree(account?.plan)) {
    const named = account!.plan!.models;
    for (const model of catalog.models) {
      if (named ? named.includes(baseModel(model)) : harness?.freePlan?.listed) free.add(model);
    }
  }
  return free;
}

/** The free model a refused turn goes on with: when the refusal is the
 * vendor's "not on your plan" (catalog `freePlan.refusals`) and the model it
 * refused is not free (preferredFreeModel). Undefined: another failure, or nothing free to go on with. */
export function freeModelAfterPlanRefusal(
  harness: Pick<AiLocalHarnessDefinition, 'freePlan'>, model: string | null | undefined, failure: unknown, free: ReadonlySet<string>,
): string | undefined {
  const refusals = harness.freePlan?.refusals;
  if (!refusals?.length || !model || free.has(model)) return undefined;
  const message = (failure instanceof Error ? failure.message : String(failure)).toLowerCase();
  if (!refusals.some((refusal) => message.includes(refusal))) return undefined;
  return preferredFreeModel(free);
}

/** The vendor's own free router first (Kilo's `kilo-auto/free`,
 * `openrouter/free`, Cursor's `default[]`: they route around a free model
 * that is overloaded, which the first listed one was), then the first. */
export function preferredFreeModel(free: ReadonlySet<string>): string | undefined {
  const listed = [...free];
  return listed.find((id) => /(?:^|[/-])(?:auto|default)\b|\/free$/.test(id)) ?? listed[0];
}
