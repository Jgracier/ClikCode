/** How the `swarm` tool reaches each host, by the channel that host has. Every
 * channel names the chat (CLIKCODE_SESSION_ID), so two chats with swarm on
 * never answer for each other. ClikCode's agent needs none of this: its
 * `task` tool delegates in-process.
 *
 *   ACP            the session's own `mcpServers` (session/new, resume)
 *   Codex          the thread's `config` (`mcp_servers.<name>`)
 *   Amp            `--mcp-config <json>` on the turn (catalog: mcpConfigArgv)
 *   Pi             an extension file on the turn (catalog: extensionArgv);
 *                  Pi has no MCP, so the extension asks this same server
 *   anything else  the vendor's own MCP list, by its `mcp add`; the server
 *                  finds the chat from the turn's environment or process
 *                  ancestry, and lists no tool for a chat with swarm off. */

import type { AiLocalHarnessDefinition } from '../harness/definition.js';
import type { McpServerEntry } from '../harness/mcp-registry.js';
import { clikcodeLauncher } from '../search/mcp-entry.js';
import { writePiSwarmExtension } from './pi-extension.js';

export const SWARM_MCP_NAME = 'clikcode-swarm';
export const SWARM_MCP_COMMAND = 'swarm-mcp';
/** Set on a clerk's process: a clerk never gets the swarm tool. */
export const SWARM_CLERK_ENV = 'CLIKCODE_SWARM_CLERK';

export interface SwarmServer { command: string; args: string[]; env: Record<string, string> }

function launch(): { command: string; args: string[] } | undefined {
  const launcher = clikcodeLauncher();
  return launcher && { command: launcher.target, args: [...launcher.args, SWARM_MCP_COMMAND] };
}

function server(sessionId: string): SwarmServer | undefined {
  const base = launch();
  if (!base) return undefined;
  const home = process.env.CLIKCODE_HOME?.trim();
  return { ...base, env: { CLIKCODE_SESSION_ID: sessionId, ...(home ? { CLIKCODE_HOME: home } : {}) } };
}

/** For an ACP session's `mcpServers`. */
export function swarmAcpMcpServers(sessionId: string): Array<{ name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }> {
  const found = server(sessionId);
  if (!found) return [];
  return [{ name: SWARM_MCP_NAME, command: found.command, args: found.args, env: Object.entries(found.env).map(([name, value]) => ({ name, value })) }];
}

/** For a Codex thread's `config`, beside the user's own overrides. Checked
 * live on codex 0.155.1: the thread starts this server with this env. */
export function swarmCodexConfig(sessionId: string): Record<string, unknown> {
  const found = server(sessionId);
  return found ? { [`mcp_servers.${SWARM_MCP_NAME}`]: found } : {};
}

/** The entry written into a vendor's own MCP list, for a host with no
 * per-session or per-turn channel. */
export function swarmProvisionEntry(): McpServerEntry | undefined {
  const base = launch();
  return base && { name: SWARM_MCP_NAME, target: base.command, args: base.args };
}

/** True when the tool rides on the session or the turn itself, so nothing is
 * written into the vendor's MCP list. */
export function swarmRidesTurn(harness: AiLocalHarnessDefinition): boolean {
  return Boolean(harness.acp || harness.transport === 'codex-app-server' || harness.turn?.mcpConfigArgv || harness.turn?.extensionArgv);
}

/** Argv a CLI turn carries so its vendor gets the tool. */
export async function swarmTurnArgv(turn: AiLocalHarnessDefinition['turn'], sessionId: string): Promise<string[]> {
  if (turn?.mcpConfigArgv) {
    const found = server(sessionId);
    return found ? [...turn.mcpConfigArgv, JSON.stringify({ [SWARM_MCP_NAME]: found })] : [];
  }
  if (turn?.extensionArgv) {
    const base = launch();
    return base ? [...turn.extensionArgv, await writePiSwarmExtension(base)] : [];
  }
  return [];
}
