/** Which of an account's models its vendor's free plan runs. Nothing here
 * names a model: each fact is the vendor's own, read where it publishes it
 * (catalog `freePlan` says only where to look).
 *
 * - An id with the harness's free suffix (`freePlan.suffix`: OpenRouter's
 *   `:free`, which Cline, Kilo, Hermes's Nous and OpenRouter routes share;
 *   not Cline's `openrouter/free`, which it bills: "Insufficient balance").
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
  const suffix = harness?.freePlan?.suffix;
  if (suffix) for (const model of catalog.models) if (model.endsWith(suffix)) free.add(model);
  if (planIsFree(account?.plan)) {
    const named = account!.plan!.models;
    for (const model of catalog.models) {
      if (named ? named.includes(baseModel(model)) : harness?.freePlan?.listed) free.add(model);
    }
  }
  return free;
}

/** The model a free-plan account starts on: the vendor's own router first
 * (Cursor's `default[]`, Kiro's `auto`), then the first listed. */
export function preferredFreeModel(free: ReadonlySet<string>): string | undefined {
  const listed = [...free];
  return listed.find((id) => /(?:^|[/-])(?:auto|default)\b|\/free$/.test(id)) ?? listed[0];
}
