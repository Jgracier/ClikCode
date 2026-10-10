/** A Gateway agent, run as ClikCode's own agent.
 *
 * ClikCode is the harness and the Gateway supplies the model; an agent such as @silas adds who it is
 * and the platform tools it holds. ClikDeploy returns that per turn (POST /v1/agents/{id}/session): the
 * agent's instructions, model and settings, and a short-lived key for its tools at /mcp, which serves
 * exactly the agent's grant under the agent's own permission mode. The turn then runs locally with every
 * ClikCode tool beside the agent's -- files, shell, attachments, the user's MCP servers, subagents, undo.
 */

import type Conf from 'conf';
import type { McpServerSpec } from '../agent/mcp/config.js';
import { gatewayConnection } from '../agent/models/for-session.js';
import type { HarnessSession } from '../session/model.js';
import { CLIKCODE_USER_AGENT } from '../version.js';
import { gatewayErrorMessage } from './error-message.js';

export interface GatewayAgentSession {
  agent: { id: string; handle: string; name: string };
  /** The agent's identity, charter and run facts. */
  system: string;
  /** The model the agent runs on, as the Gateway names it; null = the Gateway chooses. */
  model: string | null;
  effort: string | null;
  permissionMode: string;
  mcp?: { path: string; apiKey: string; expiresAt: string; core?: readonly string[] };
}

/** The agent for this turn; undefined when the server has no such endpoint (an older ClikDeploy). */
export async function gatewayAgentSession(config: Conf, session: HarnessSession, signal?: AbortSignal): Promise<GatewayAgentSession | undefined> {
  const agentId = session.gatewayAgentId;
  if (!agentId) return undefined;
  const { baseUrl, apiKey } = gatewayConnection(config);
  const response = await fetch(`${baseUrl}/v1/agents/${encodeURIComponent(agentId)}/session`, {
    method: 'POST',
    ...(signal ? { signal } : {}),
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', 'content-type': 'application/json', 'user-agent': CLIKCODE_USER_AGENT },
    body: JSON.stringify({
      // The session's own choices win over the agent's, as they do for every turn the agent takes.
      ...(session.model ? { model: session.model } : {}),
      ...(session.permissionMode ? { permissionMode: session.permissionMode } : {}),
    }),
  });
  if (response.status === 404 || response.status === 405) {
    const body = await response.json().catch(() => ({}));
    // An unknown agent is a real refusal; a missing route is an older server.
    if (gatewayErrorMessage(body) === 'Agent not found') throw new Error(`@${session.gatewayAgentName ?? 'agent'} is not available to this Gateway account.`);
    return undefined;
  }
  const body = await response.json().catch(() => ({})) as GatewayAgentSession & { error?: unknown };
  if (!response.ok) throw new Error(gatewayErrorMessage(body) ?? `The Gateway agent could not be started (${response.status}).`);
  return body;
}

/** The agent's tools as an MCP server beside ClikCode's own: its whole grant, its chat core always loaded. */
export function agentMcpServer(config: Conf, agent: GatewayAgentSession): McpServerSpec | undefined {
  if (!agent.mcp) return undefined;
  const { baseUrl } = gatewayConnection(config);
  // The Gateway serves /v1 under its origin; /mcp is at the origin itself.
  const origin = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  return {
    name: agent.agent.handle,
    transport: 'http',
    url: `${origin}${agent.mcp.path}`,
    headers: { authorization: `Bearer ${agent.mcp.apiKey}` },
    ...(agent.mcp.core?.length ? { core: agent.mcp.core } : {}),
  };
}
