/** What a session's route means, asked as the two questions callers actually
 * have.
 *
 * `route` names where inference comes from, but most checks of it were never
 * about inference. Two routes run ClikCode's OWN agent loop on this machine --
 * the Gateway (ClikDeploy supplies the model remotely) and ClikCode Local (a
 * model on this machine supplies it). Everything about the agent itself holds
 * for both: no vendor harness or native slash commands, no vendor accounts,
 * ClikCode's own permission modes, tools, MCP and skills.
 * Only what the ClikDeploy service itself provides -- its login, its credit
 * and usage reporting, its platform-managed model and effort routing --
 * belongs to the Gateway alone.
 *
 * A check of `route === 'gateway'` has to pick one of those meanings; these
 * two names make the pick visible at the call site. */

import type { AiHarnessRoute } from '../harness/definition.js';

type Routed = { route?: AiHarnessRoute } | null | undefined;

/** The session runs ClikCode's own agent (tools, MCP, skills, permission
 * modes), whichever inference feeds it. */
export function isClikCodeAgent(session: Routed): boolean {
  return session?.route === 'gateway' || session?.route === 'clikcode-local';
}

/** The session is served by the ClikDeploy Gateway service: its login, its
 * usage and credit, its platform-managed routing and fallbacks. */
export function isGatewayService(session: Routed): boolean {
  return session?.route === 'gateway';
}

/** The provider of every session that runs ClikCode's own agent. A model on this computer is hosted AI under the Gateway
 * (hosted-models/), so a chat on one is on the Gateway here too: no screen names a provider of its own for it. */
export const GATEWAY_LABEL = 'ClikDeploy Gateway';

/** The built-in agent has no native compaction operation to relay. */
export const AGENT_COMPACT_UNAVAILABLE = '/compact is only available for vendor harnesses that support it.';

const AI_HARNESS_ROUTES: readonly AiHarnessRoute[] = ['local', 'gateway', 'clikcode-local'];

export function isAiHarnessRoute(value: unknown): value is AiHarnessRoute {
  return typeof value === 'string' && (AI_HARNESS_ROUTES as readonly string[]).includes(value);
}

export const ROUTE_CHOICES_TEXT = 'route must be local, gateway, or clikcode-local';
