/** How a vendor harness starts ClikCode's conversation MCP server: the
 * installed `clikcode` itself, `clikcode conversations-mcp`. Kept apart from
 * the server so provisioning does not load it. */
import { accessSync, constants } from 'node:fs';
import type { McpServerEntry } from '../harness/mcp-registry.js';

export const CONVERSATIONS_MCP_NAME = 'clikcode-conversations';
export const CONVERSATIONS_MCP_COMMAND = 'conversations-mcp';

function executable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

/** The installed launcher when it runs on its own (a `#!/usr/bin/env node`
 * script, so the entry survives a Node upgrade), otherwise Node with the
 * script. Undefined when this process has no script to name. */
export function conversationsMcpEntry(
  script: string | undefined = process.argv[1], execPath = process.execPath, platform: NodeJS.Platform = process.platform,
  isExecutable: (path: string) => boolean = executable,
): McpServerEntry | undefined {
  if (!script) return undefined;
  const direct = platform !== 'win32' && isExecutable(script);
  return direct
    ? { name: CONVERSATIONS_MCP_NAME, target: script, args: [CONVERSATIONS_MCP_COMMAND] }
    : { name: CONVERSATIONS_MCP_NAME, target: execPath, args: [script, CONVERSATIONS_MCP_COMMAND] };
}
