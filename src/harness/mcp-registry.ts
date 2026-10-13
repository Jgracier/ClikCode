/**
 * The MCP servers a user records for ClikCode's own agent, in
 * `<state dir>/mcp.json` (read by agent/mcp/config.ts).
 *
 * A vendor harness keeps its own MCP configuration: ClikCode never writes a
 * server into it. This file's `mcpServers` object is the user's, so a write
 * merges one entry and leaves everything else as it was.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MCP_SERVERS_KEY, mcpConfigFilePath } from '../agent/mcp/config.js';
import { stateDirectory } from '../session/store/paths.js';

/** What a user asked ClikCode to make available. */
export interface McpServerEntry {
  name: string;
  /** A URL for a remote server, or the executable for a local one. */
  target: string;
  /** Arguments for a local server; meaningless for a URL. */
  args?: readonly string[];
  /** Sent with every request to a remote server (an API key, say). */
  headers?: Readonly<Record<string, string>>;
  /** Set for a local server's process. */
  env?: Readonly<Record<string, string>>;
}

export function isRemoteTarget(target: string): boolean {
  return /^https?:\/\//i.test(target);
}

/** One server, spelled the `mcpServers` way: `{ command, args }` or `{ url }`. */
export function mcpConfigEntry(entry: McpServerEntry): Record<string, unknown> {
  return isRemoteTarget(entry.target)
    ? { url: entry.target, ...(nonEmpty(entry.headers) ? { headers: { ...entry.headers } } : {}) }
    : {
      command: entry.target,
      ...(entry.args?.length ? { args: [...entry.args] } : {}),
      ...(nonEmpty(entry.env) ? { env: { ...entry.env } } : {}),
    };
}

function nonEmpty(record: Readonly<Record<string, string>> | undefined): record is Readonly<Record<string, string>> {
  return !!record && Object.keys(record).length > 0;
}

async function readRoot(path: string): Promise<Record<string, unknown> | undefined> {
  const existing = await readFile(path, 'utf8').catch(() => undefined);
  if (!existing?.trim()) return undefined;
  const parsed: unknown = JSON.parse(existing);
  // A file that is not an object is not something to merge into.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object`);
  return parsed as Record<string, unknown>;
}

/** Merges one server into the file, preserving everything else in it --
 *  other servers, and any key this does not know about. */
export async function writeMcpConfigEntry(path: string, key: string, entry: McpServerEntry): Promise<void> {
  const root = await readRoot(path) ?? {};
  const current = root[key];
  const servers = current && typeof current === 'object' && !Array.isArray(current)
    ? { ...current as Record<string, unknown> }
    : {};
  servers[entry.name] = mcpConfigEntry(entry);
  root[key] = servers;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(root, null, 2)}\n`, 'utf8');
}

/** Records a server for ClikCode's own agent (the Gateway and local routes). */
export async function recordSharedMcpServer(entry: McpServerEntry): Promise<void> {
  await writeMcpConfigEntry(mcpConfigFilePath(stateDirectory()), MCP_SERVERS_KEY, entry);
}

/** Removes one server from the file, leaving everything else in it as it was. */
export async function removeMcpConfigEntry(path: string, key: string, name: string): Promise<boolean> {
  const root = await readRoot(path);
  const servers = root?.[key];
  if (!root || !servers || typeof servers !== 'object' || Array.isArray(servers) || !(name in servers)) return false;
  delete (servers as Record<string, unknown>)[name];
  await writeFile(path, `${JSON.stringify(root, null, 2)}\n`, 'utf8');
  return true;
}
