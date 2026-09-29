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

/** What the body of every Gateway step adds for these choices. */
export function gatewayStepOptions(session: Pick<HarnessSession, 'effort' | 'speed'>): Record<string, unknown> {
  const effort = gatewayEffort(session);
  return {
    ...(effort ? { reasoning_effort: effort } : {}),
    ...(session.speed === 'fast' ? { speed: 'fast' } : {}),
  };
}
