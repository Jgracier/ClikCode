/** ClikDeploy's own MCP server, which every Gateway conversation gets.
 *
 * The platform serves ~1,000 account tools at /mcp -- apps, deploys, logs,
 * env, servers, backups -- ~670 KB of schemas, far too many to send on every
 * step. Its search mode (`?toolmode=search`) serves a pinned everyday set plus
 * `search_tools` (semantic search over the whole catalogue) and `call_tool`
 * (runs any of them, with the same validation and confirmation gate as a
 * direct call). Of those, the CLI-like core below is always offered; the rest
 * of the pinned set waits behind the loader, and everything else is a search
 * away. Authenticated with the Gateway's own key, so it is exactly the account
 * the conversation already runs on. Each tool carries the platform's risk as
 * MCP annotations: reads run freely, writes follow the conversation's
 * approval setting. */

import type Conf from 'conf';
import type { McpServerSpec } from '../agent/mcp/config.js';
import { gatewayConnection } from '../agent/models/for-session.js';
import { isGatewayService } from '../session/route.js';
import type { HarnessSession } from '../session/model.js';

export const CLIKDEPLOY_MCP_SERVER = 'clikdeploy';

/** What an agent reaches for without searching: who am I, my apps, their
 * logs and deployments, deploy and restart -- and the search and dispatcher
 * for the rest. */
export const CLIKDEPLOY_CORE_TOOLS: readonly string[] = [
  'meta_read', 'list_apps', 'get_app', 'get_app_logs', 'list_deployments', 'get_deployment',
  'deploy_app', 'restart_app', 'search_tools', 'call_tool',
];

/** How long a Gateway turn waits for ClikDeploy's MCP server. */
export const CLIKDEPLOY_MCP_TURN_WAIT_MS = 3000;

export function clikDeployMcpServer(connection: { baseUrl: string; apiKey: string }): McpServerSpec {
  return {
    name: CLIKDEPLOY_MCP_SERVER,
    transport: 'http',
    url: `${connection.baseUrl.replace(/\/+$/, '')}/mcp?toolmode=search`,
    headers: { authorization: `Bearer ${connection.apiKey}` },
    core: CLIKDEPLOY_CORE_TOOLS,
    // Its tools/list took the whole 30 s connect timeout in a harness
    // benchmark run (bench/harness), and every Gateway turn waited for it
    // before its first model step, coding turn or not. It answers in ~0.3 s
    // when healthy; a slower start joins a later turn instead.
    turnWaitMs: CLIKDEPLOY_MCP_TURN_WAIT_MS,
  };
}

/** The servers a conversation's route brings: the ClikDeploy server on the
 * Gateway (when signed in), none elsewhere. */
export function routeMcpServers(session: HarnessSession, config: Conf): McpServerSpec[] {
  if (!isGatewayService(session)) return [];
  try {
    return [clikDeployMcpServer(gatewayConnection(config))];
  } catch {
    // Not signed in: the turn itself says so; there is no account to control.
    return [];
  }
}

