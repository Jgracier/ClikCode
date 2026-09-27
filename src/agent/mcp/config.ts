/** Which MCP servers ClikCode's own agent connects to.
 *
 * The source is `<state dir>/mcp.json`, in the same `{ "mcpServers": { … } }`
 * shape Cursor, Kimi and Claude's project file use, and it is written by the
 * same `clikcode mcp add` (and the Tools picker) that fans a server out to
 * every vendor harness -- see installMcpServerEverywhere. So a user adds a
 * server once and every harness, this one included, has it.
 *
 * The file is read, never assumed to be ClikCode's alone: a user may edit it by
 * hand, so the keys other tools write (`env`, `headers`, `type`, `disabled`)
 * are honoured rather than dropped.
 *
 * A project-level `.mcp.json` is deliberately NOT read. The vendor-harness
 * registry honours none either, and a repository that could name a command
 * for this agent to spawn would be code execution on clone, before any
 * approval prompt could be shown.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type McpServerSpec = (
  | { name: string; transport: 'stdio'; command: string; args: readonly string[]; env: Readonly<Record<string, string>> }
  | { name: string; transport: 'http' | 'sse'; url: string; headers: Readonly<Record<string, string>> }
) & {
  /** Tools of this server always offered with their schemas, never deferred
   * behind the loader -- a built-in server's everyday set (the rest are found
   * with its search). Absent: every tool follows the deferral rule. */
  core?: readonly string[];
};

export const MCP_SERVERS_KEY = 'mcpServers';

export function mcpConfigFilePath(stateDir: string): string {
  return join(stateDir, 'mcp.json');
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

/** One entry as written by us or by hand, or undefined when it names nothing
 * runnable. `type: "sse"` is the only way to ask for the legacy transport;
 * any other URL starts with streamable HTTP and falls back on its own. */
export function parseMcpServerEntry(name: string, raw: unknown): McpServerSpec | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const entry = raw as Record<string, unknown>;
  if (entry.disabled === true || entry.enabled === false) return undefined;
  const url = typeof entry.url === 'string' ? entry.url : typeof entry.uri === 'string' ? entry.uri : undefined;
  if (url && /^https?:\/\//i.test(url)) {
    return { name, transport: entry.type === 'sse' ? 'sse' : 'http', url, headers: stringRecord(entry.headers) };
  }
  const command = typeof entry.command === 'string' ? entry.command : typeof entry.cmd === 'string' ? entry.cmd : undefined;
  if (!command?.trim()) return undefined;
  const args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === 'string') : [];
  return { name, transport: 'stdio', command, args, env: stringRecord(entry.env) };
}

/** Every usable server in the file. A missing file is the normal case (no
 * servers); a malformed one is reported, because silently offering no tools
 * would look like the servers themselves were broken. */
export async function loadMcpServers(stateDir: string): Promise<{ servers: McpServerSpec[]; problem?: string }> {
  const path = mcpConfigFilePath(stateDir);
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch { return { servers: [] }; }
  if (!text.trim()) return { servers: [] };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { servers: [], problem: `${path} is not valid JSON; no MCP servers were started` }; }
  const table = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>)[MCP_SERVERS_KEY] : undefined;
  if (!table || typeof table !== 'object' || Array.isArray(table)) return { servers: [] };
  return {
    servers: Object.entries(table).flatMap(([name, raw]) => parseMcpServerEntry(name, raw) ?? []),
  };
}
