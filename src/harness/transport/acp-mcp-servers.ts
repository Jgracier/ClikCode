/** The global MCP servers (`<state dir>/mcp.json`, `clikcode mcp add`) as the
 * `mcpServers` of an ACP session, so they work in any harness through ClikCode.
 *
 * A harness keeps the servers it has of its own: one named in its own config
 * is left out here, so it never runs twice (an imported server is in both
 * files). ClikCode still writes nothing into a vendor's config -- the servers
 * travel with the session, not in a file. */
import { homedir } from 'node:os';
import { loadMcpServers, type McpServerSpec } from '../../agent/mcp/config.js';
import { vendorMcpServerNames } from '../../agent/mcp/import.js';
import { stateDirectory } from '../../session/store/paths.js';

type Json = Record<string, any>;

const pairs = (record: Readonly<Record<string, string>>): Json[] => Object.entries(record).map(([name, value]) => ({ name, value }));

/** One server in ACP's spelling; undefined when the harness cannot take its transport. */
export function acpMcpServer(spec: McpServerSpec, capabilities: Json | undefined): Json | undefined {
  if (spec.transport === 'stdio') return { name: spec.name, command: spec.command, args: [...spec.args], env: pairs(spec.env) };
  if (!capabilities?.mcpCapabilities?.[spec.transport]) return undefined;
  return { type: spec.transport, name: spec.name, url: spec.url, headers: pairs(spec.headers) };
}

export async function globalMcpServersForAcp(command: string, capabilities: Json | undefined, home: string = homedir()): Promise<Json[]> {
  if (process.env.VITEST && !process.env.CLIKCODE_HOME?.trim()) return [];
  try {
    const { servers } = await loadMcpServers(stateDirectory());
    if (!servers.length) return [];
    const { names } = await vendorMcpServerNames(command, home);
    return servers.filter((server) => !names.has(server.name)).flatMap((server) => acpMcpServer(server, capabilities) ?? []);
  } catch {
    // MCP must never be the reason a turn did not run.
    return [];
  }
}
