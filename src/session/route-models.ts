/** The model a conversation last used on each route, so moving away and back
 * lands on it again instead of on a default.
 *
 * A route is the Gateway, ClikCode Local, or one vendor harness. Leaving one
 * writes the conversation's model on it into `routeModels`; arriving at one
 * reads that back, and for a conversation that never ran there, the model
 * the most recently used conversation on that route had. `null` is a choice
 * too (the Gateway's Automatic), and is remembered as one. */
import type { HarnessSession, HarnessState } from './model.js';

/** `gateway`, `clikcode-local`, or the vendor harness's command; undefined for a conversation on none. */
export function routeKeyOf(session: Pick<HarnessSession, 'route' | 'nativeHarness'>): string | undefined {
  if (session.route === 'gateway') return 'gateway';
  if (session.route === 'clikcode-local') return 'clikcode-local';
  return session.nativeHarness;
}

/** Called before a conversation leaves its route. */
export function rememberRouteModel(session: HarnessSession): void {
  const key = routeKeyOf(session);
  if (!key) return;
  session.routeModels = { ...session.routeModels, [key]: session.model ?? null };
}

/** The model to start on when arriving at `key`: this conversation's own last one, else the latest
 * any conversation used there. Undefined when nothing was ever used (the route's default applies). */
export function recallRouteModel(session: HarnessSession, key: string, state?: HarnessState): string | null | undefined {
  const own = session.routeModels;
  if (own && key in own) return own[key];
  const latest = [...(state?.sessions ?? [])]
    .filter((other) => other.id !== session.id && routeKeyOf(other) === key && other.model)
    .sort((left, right) => Date.parse(right.updatedAt ?? '') - Date.parse(left.updatedAt ?? ''))[0];
  return latest?.model ?? undefined;
}
