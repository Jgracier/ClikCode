/** Give the host harness a `swarm` tool, once. ClikCode's own agent does not
 * need it: its `task` tool already delegates. A vendor host (Claude Code,
 * Cursor) only delegates through a tool it can call. */

import { homedir } from 'node:os';
import { installMcpOnHarness, type McpServerEntry } from '../harness/mcp-registry.js';
import { vendorMcpServerNames } from '../agent/mcp/import.js';
import { localHarnessForCommand } from '../runtime/lazy-bridge.js';
import type { HarnessSession, HarnessState } from '../session/model.js';

export const SWARM_MCP_NAME = 'clikcode-swarm';

export function swarmMcpEntry(): McpServerEntry {
  return { name: SWARM_MCP_NAME, target: process.execPath, args: [process.argv[1] ?? '', 'swarm-mcp'] };
}

/** Install the tool into this conversation's harness when it is not already
 * there. A failure leaves the swarm setting on; the host's own agent still
 * delegates, and the next turn can try the install again. */
export async function installSwarmTool(session: HarnessSession, state: HarnessState): Promise<void> {
  if (session.route !== 'local' || !session.nativeHarness) return;
  const harness = localHarnessForCommand(session.nativeHarness);
  if (!harness) return;
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  const profile = account?.nativeProfile ? { env: account.nativeProfile.env, path: account.nativeProfile.path } : undefined;
  const present = await vendorMcpServerNames(harness.command, homedir(), profile);
  if (present.names.has(SWARM_MCP_NAME)) return;
  await installMcpOnHarness(harness, swarmMcpEntry(), account);
}
