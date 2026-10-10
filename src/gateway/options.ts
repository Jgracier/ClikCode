/** What a Gateway conversation can ask of the Gateway beyond its model:
 * how hard a reasoning model thinks, and whether to be served by the fastest
 * provider rather than the cheapest. Both travel with every step
 * (`reasoning_effort`, `speed`) on the Gateway's OpenAI-compatible API. */

import type { HarnessSession } from '../session/model.js';

/** The Gateway's reasoning levels, lowest first. `none` turns reasoning off. */
export const GATEWAY_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type GatewayEffort = (typeof GATEWAY_EFFORTS)[number];

/** A Gateway session's effort when it chose one; the model's own default otherwise. */
export function gatewayEffort(session: Pick<HarnessSession, 'effort'>): GatewayEffort | undefined {
  return (GATEWAY_EFFORTS as readonly string[]).includes(session.effort) ? session.effort as GatewayEffort : undefined;
}

/** The effort a Gateway session holds when it has chosen none. */
export const GATEWAY_DEFAULT_EFFORT = 'platform-managed';

/**
 * The effort a session that chose none runs at, for the model serving it: what Claude Code runs
 * that model at, so a ClikCode step thinks as much as Claude Code's on the same model. Claude Code
 * (2.1.289) defaults Claude Sonnet 5.5 and Claude Opus 5.5 to `medium`; left to the vendor they run
 * `high`, which MEASURED 2026-10-10 as 0-330 silent reasoning tokens and 1-5 s before the first
 * token on small steps. Undefined = the model's own default (every other model; Claude Code also
 * leaves the rest at theirs).
 */
export function gatewayDefaultEffort(model: string | undefined): GatewayEffort | undefined {
  return model && /claude-(?:sonnet|opus)-5[-.]5/i.test(model) ? 'medium' : undefined;
}

/** What the body of every Gateway step adds for these choices. `model`: the model the step will
 * run (the session's pick, else the Gateway's automatic one), for the default effort. */
export function gatewayStepOptions(session: Pick<HarnessSession, 'effort' | 'speed'>, model?: string): Record<string, unknown> {
  const effort = gatewayEffort(session) ?? gatewayDefaultEffort(model);
  return {
    ...(effort ? { reasoning_effort: effort } : {}),
    ...(session.speed === 'fast' ? { speed: 'fast' } : {}),
  };
}
