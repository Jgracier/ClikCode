/** How a vendor harness starts ClikCode's conversation MCP server: the
 * installed `clikcode` itself, `clikcode conversations-mcp`. Kept apart from
 * the server so provisioning does not load it.
 *
 * dist/index.js loads only dist/conversations-mcp.js for that command, so
 * the entry every vendor config already holds is the lean one too: nothing
 * written into a vendor's config has to be found and rewritten. */
import { accessSync, constants, realpathSync } from 'node:fs';
import type { McpServerEntry } from '../harness/mcp-registry.js';

export const CONVERSATIONS_MCP_NAME = 'clikcode-conversations';
export const CONVERSATIONS_MCP_COMMAND = 'conversations-mcp';

function executable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

/** How another program starts the installed ClikCode: the launcher when it
 * runs on its own (a `#!/usr/bin/env node` script, so the entry survives a
 * Node upgrade), otherwise Node with the script. Undefined when this process
 * has no script to name. */
export function clikcodeLauncher(
  script: string | undefined = process.argv[1], execPath = process.execPath, platform: NodeJS.Platform = process.platform,
  isExecutable: (path: string) => boolean = executable,
): { target: string; args: string[] } | undefined {
  if (!script) return undefined;
  return platform !== 'win32' && isExecutable(script) ? { target: script, args: [] } : { target: execPath, args: [script] };
}

/** The launcher, only when it is the built dist/index.js -- the one that
 * knows `npx-mcp` (scripts/build.mjs). Run from source, an entry naming it
 * would not start. */
export function builtClikcodeLauncher(script: string | undefined = process.argv[1]): { target: string; args: string[] } | undefined {
  if (!script) return undefined;
  let real: string;
  try { real = realpathSync(script); } catch { return undefined; }
  return /[\\/]dist[\\/]index\.js$/.test(real) ? clikcodeLauncher(script) : undefined;
}

export function conversationsMcpEntry(
  script: string | undefined = process.argv[1], execPath = process.execPath, platform: NodeJS.Platform = process.platform,
  isExecutable: (path: string) => boolean = executable,
): McpServerEntry | undefined {
  const launcher = clikcodeLauncher(script, execPath, platform, isExecutable);
  return launcher && { name: CONVERSATIONS_MCP_NAME, target: launcher.target, args: [...launcher.args, CONVERSATIONS_MCP_COMMAND] };
}

/** The server as an ACP session's `mcpServers` entry (stdio), for a vendor
 * whose own configuration could not be given it: opencode and Kilo add only
 * remote servers, and several ACP agents have no add at all. Without this
 * those agents were blind to the user's other conversations. `env` is
 * stated, not inherited: ACP leaves a server's environment to the client. */
export function conversationsForAcpSession(
  entry: McpServerEntry | undefined, notProvisioned: readonly string[], env: Readonly<Record<string, string>>,
): Array<{ name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }> {
  if (!entry || !notProvisioned.includes(entry.name)) return [];
  return [{ name: entry.name, command: entry.target, args: [...entry.args ?? []], env: Object.entries(env).map(([name, value]) => ({ name, value })) }];
}
