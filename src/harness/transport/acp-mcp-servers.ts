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
import { computerEnabledSync } from '../../agent/computer/settings.js';
import { stateDirectory } from '../../session/store/paths.js';

type Json = Record<string, any>;

const pairs = (record: Readonly<Record<string, string>>): Json[] => Object.entries(record).map(([name, value]) => ({ name, value }));

/** One server in ACP's spelling; undefined when the harness cannot take its transport. */
export function acpMcpServer(spec: McpServerSpec, capabilities: Json | undefined): Json | undefined {
  if (spec.transport === 'stdio') return { name: spec.name, command: spec.command, args: [...spec.args], env: pairs(spec.env) };
  if (!capabilities?.mcpCapabilities?.[spec.transport]) return undefined;
  return { type: spec.transport, name: spec.name, url: spec.url, headers: pairs(spec.headers) };
}

/** ClikCode's own server, in every harness session: computer use and secret
 * capture work the same in any harness. Nothing is installed or recorded; it
 * is the clikcode that is running now, told which worker to call back. */
export const BUILT_IN_MCP_NAME = 'clikcode';
export function builtInMcpServer(): McpServerSpec | undefined {
  const entry = process.env.CLIKCODE_MCP_ENTRY || process.argv[1];
  if (!entry || !computerEnabledSync(stateDirectory())) return undefined;
  return { name: BUILT_IN_MCP_NAME, transport: 'stdio', command: process.execPath, args: [entry, 'mcp-serve'], env: { CLIKCODE_WORKER_PID: String(process.pid) } };
}

export async function globalMcpServersForAcp(command: string, capabilities: Json | undefined, home: string = homedir()): Promise<Json[]> {
  if (process.env.VITEST && !process.env.CLIKCODE_HOME?.trim()) return [];
  try {
    const { servers: recorded } = await loadMcpServers(stateDirectory());
    // A server the user recorded under this name wins; the built-in one steps aside.
    const builtIn = builtInMcpServer();
    const servers = builtIn && !recorded.some((server) => server.name === builtIn.name) ? [builtIn, ...recorded] : recorded;
    if (!servers.length) return [];
    const { names } = await vendorMcpServerNames(command, home);
    return servers.filter((server) => !names.has(server.name)).flatMap((server) => acpMcpServer(server, capabilities) ?? []);
  } catch {
    // MCP must never be the reason a turn did not run.
    return [];
  }
}

/** The same built-in server for Codex's app-server, which takes its MCP servers as
 * `-c` config overrides on the launch line (verified against codex-cli 0.162: the
 * server shows up in mcpServerStatus/list). Nothing is written to Codex's config. */
export function codexBuiltInMcpArgs(): string[] {
  const server = builtInMcpServer();
  if (!server || server.transport !== 'stdio') return [];
  const prefix = `mcp_servers.${server.name}`;
  const env = Object.entries(server.env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(',');
  return ['-c', `${prefix}.command=${JSON.stringify(server.command)}`, '-c', `${prefix}.args=${JSON.stringify(server.args)}`, ...(env ? ['-c', `${prefix}.env={${env}}`] : [])];
}
