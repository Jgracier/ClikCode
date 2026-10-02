/** Give the host harness a `swarm` tool, once. ClikCode's own agent does not
 * need it: its `task` tool already delegates. A vendor host (Claude Code,
 * Cursor) only delegates through a tool it can call. */

import { homedir } from 'node:os';
import { installMcpOnHarness, mcpAddGrammar, mcpConfigFile, type McpServerEntry } from '../harness/mcp-registry.js';
import { vendorMcpServerNames } from '../agent/mcp/import.js';
import type { AiLocalHarnessDefinition } from '../harness/definition.js';
import { localHarnessForCommand } from '../runtime/lazy-bridge.js';
import type { HarnessSession, HarnessState } from '../session/model.js';

export const SWARM_MCP_NAME = 'clikcode-swarm';

export function swarmMcpEntry(): McpServerEntry {
  return { name: SWARM_MCP_NAME, target: process.execPath, args: [process.argv[1] ?? '', 'swarm-mcp'] };
}

/** True when `installSwarmTool` can register a local stdio server. A
 * remote-only `mcp add`, or no recorded surface, cannot. */
export function harnessCanInstallLocalMcp(harness: AiLocalHarnessDefinition): boolean {
  const add = mcpAddGrammar(harness);
  if (add) return !add.remoteOnly;
  return Boolean(mcpConfigFile(harness));
}

/** The same server, in the shape ACP `session/new` and `session/resume` take.
 * Used for a host that speaks ACP and cannot install a local server. */
export function swarmAcpMcpServers(): Array<{ name: string; command: string; args: string[]; env: [] }> {
  const entry = swarmMcpEntry();
  return [{ name: entry.name, command: entry.target, args: [...(entry.args ?? [])], env: [] }];
}

/** Install the tool into this conversation's harness when it is not already
 * there. True when this call wrote it, so the caller can restart a vendor
 * process that started before the tool existed. A failure leaves the swarm
 * setting on; the host's own agent still delegates, and the next turn retries. */
export async function installSwarmTool(session: HarnessSession, state: HarnessState): Promise<boolean> {
  if (session.route !== 'local' || !session.nativeHarness) return false;
  const harness = localHarnessForCommand(session.nativeHarness);
  if (!harness) return false;
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  const profile = account?.nativeProfile ? { env: account.nativeProfile.env, path: account.nativeProfile.path } : undefined;
  const present = await vendorMcpServerNames(harness.command, homedir(), profile);
  if (present.names.has(SWARM_MCP_NAME)) return false;
  const result = await installMcpOnHarness(harness, swarmMcpEntry(), account);
  return result.ok;
}
