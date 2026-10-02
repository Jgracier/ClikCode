/** The `swarm` tool on the ACP session ClikCode is already opening. It is not
 * installed into the vendor's own MCP list. ClikCode's agent does not need
 * this entry: its `task` tool delegates in-process. */

import type { McpServerEntry } from '../harness/mcp-registry.js';

export const SWARM_MCP_NAME = 'clikcode-swarm';

function swarmMcpEntry(): McpServerEntry {
  return { name: SWARM_MCP_NAME, target: process.execPath, args: [process.argv[1] ?? '', 'swarm-mcp'] };
}

/** What `session/new` and `session/resume` carry while swarm is on. The
 * vendor process spawns it for that session and no other. */
export function swarmAcpMcpServers(): Array<{ name: string; command: string; args: string[]; env: [] }> {
  const entry = swarmMcpEntry();
  return [{ name: entry.name, command: entry.target, args: [...(entry.args ?? [])], env: [] }];
}
