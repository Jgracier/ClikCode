/** The global MCP servers (`<state dir>/mcp.json`, `clikcode mcp add`) handed to
 * every harness that can take them per run, so they work in any harness through
 * ClikCode: as the `mcpServers` of an ACP session, as `-c mcp_servers.*`
 * overrides on the Codex app-server launch, and as Amp's `--mcp-config`.
 *
 * A harness keeps the servers it has of its own: one named in its own config
 * is left out here, so it never runs twice (an imported server is in both
 * files). ClikCode still writes nothing into a vendor's config -- the servers
 * travel with the session or the launch, not in a vendor file.
 *
 * A remote server ClikCode holds an OAuth sign-in for goes with its bearer
 * (read and refreshed by agent/mcp/oauth.ts, the same code ClikCode's own agent
 * uses); one recorded as needing a sign-in is left out, since a vendor handed
 * it would start a browser sign-in of its own on every session. */
import { homedir } from 'node:os';
import { loadMcpServers, type McpServerSpec } from '../../agent/mcp/config.js';
import { vendorMcpServerNames } from '../../agent/mcp/import.js';
import { mcpOAuthProvider, mcpOAuthState } from '../../agent/mcp/oauth.js';
import { computerEnabledSync } from '../../agent/computer/settings.js';
import { stateDirectory } from '../../session/store/paths.js';

type Json = Record<string, any>;
type HttpSpec = Extract<McpServerSpec, { transport: 'http' | 'sse' }>;

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
function builtInMcpServer(): McpServerSpec | undefined {
  const entry = process.env.CLIKCODE_MCP_ENTRY || process.argv[1];
  if (!entry || !computerEnabledSync(stateDirectory())) return undefined;
  return { name: BUILT_IN_MCP_NAME, transport: 'stdio', command: process.execPath, args: [entry, 'mcp-serve'], env: { CLIKCODE_WORKER_PID: String(process.pid) } };
}

/** `spec` with the bearer of ClikCode's stored sign-in, refreshed when it is
 * about to expire; undefined when it needs a sign-in ClikCode does not hold. An
 * Authorization header the user wrote on the entry is theirs and wins. */
async function withSignIn(stateDir: string, spec: HttpSpec): Promise<HttpSpec | undefined> {
  if (Object.keys(spec.headers).some((name) => name.toLowerCase() === 'authorization')) return spec;
  const state = await mcpOAuthState(stateDir, spec);
  if (state === 'none') return spec;
  if (state === 'needs-sign-in') return undefined;
  try {
    const authorization = await mcpOAuthProvider(stateDir, spec).authorization();
    return authorization ? { ...spec, headers: { ...spec.headers, Authorization: authorization } } : undefined;
  } catch {
    // Refused at refresh: now recorded as needing a sign-in (`clikcode mcp login`).
    return undefined;
  }
}

/** The global servers a harness (`command`, reading its own config from `profile`
 * or `home`) does not already have: ClikCode's built-in one unless the user
 * recorded a server under its name, then the recorded ones, each remote one with
 * its sign-in. Never throws: MCP must never be the reason a turn did not run. */
export async function globalMcpServers(
  command: string, profile?: { env: string; path: string }, home: string = homedir(),
  /** False for a harness that takes its servers only in a file or on its command line:
   * a server that needs ClikCode's stored sign-in is left out, since its token is never
   * written anywhere new. */
  signIns = true,
): Promise<McpServerSpec[]> {
  try {
    const stateDir = stateDirectory();
    const { servers: recorded } = await loadMcpServers(stateDir);
    // A server the user recorded under this name wins; the built-in one steps aside.
    const builtIn = builtInMcpServer();
    const servers = builtIn && !recorded.some((server) => server.name === builtIn.name) ? [builtIn, ...recorded] : recorded;
    if (!servers.length) return [];
    const { names } = await vendorMcpServerNames(command, home, profile);
    const wanted = servers.filter((server) => !names.has(server.name));
    const resolved = await Promise.all(wanted.map(async (server) => {
      if (server.transport === 'stdio') return server;
      if (!signIns) return await mcpOAuthState(stateDir, server) === 'none' ? server : undefined;
      return withSignIn(stateDir, server);
    }).map((pending) => pending.catch(() => undefined)));
    return resolved.filter((server): server is McpServerSpec => server !== undefined);
  } catch {
    return [];
  }
}

export async function globalMcpServersForAcp(
  command: string, capabilities: Json | undefined, profile?: { env: string; path: string }, home: string = homedir(),
): Promise<Json[]> {
  return (await globalMcpServers(command, profile, home)).flatMap((server) => acpMcpServer(server, capabilities) ?? []);
}

/** A TOML key: bare when it may be, else quoted. */
const tomlKey = (key: string): string => (/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key));

/** The servers for Codex's app-server, which takes them as `-c` config overrides
 * on its launch line (verified against codex-cli 0.162: a server given this way
 * shows up in mcpServerStatus/list; its config schema has `command`/`args`/`env`
 * for a local server and `url`/`env_http_headers` for a streamable-HTTP one).
 * Nothing is written to Codex's config.
 *
 * Header values (an API key, a bearer) are never on the command line: each goes
 * in an environment variable of the app-server (`env`), which the override names
 * through `env_http_headers`. The variable names hold SECRET, which Codex's
 * default shell environment policy leaves out of the commands it runs. Codex
 * has no legacy SSE transport and takes only names of letters, digits, `_` and
 * `-`: those servers are left out. */
export function codexMcpLaunch(servers: readonly McpServerSpec[]): { args: string[]; env: Record<string, string> } {
  const args: string[] = [];
  const env: Record<string, string> = {};
  for (const server of servers) {
    if (!/^[A-Za-z0-9_-]+$/.test(server.name)) continue;
    const prefix = `mcp_servers.${server.name}`;
    if (server.transport === 'stdio') {
      const table = Object.entries(server.env).map(([key, value]) => `${tomlKey(key)}=${JSON.stringify(value)}`).join(',');
      args.push('-c', `${prefix}.command=${JSON.stringify(server.command)}`, '-c', `${prefix}.args=${JSON.stringify(server.args)}`, ...(table ? ['-c', `${prefix}.env={${table}}`] : []));
      continue;
    }
    if (server.transport !== 'http') continue;
    args.push('-c', `${prefix}.url=${JSON.stringify(server.url)}`);
    const headers = Object.entries(server.headers).map(([header, value]) => {
      const variable = `CLIKCODE_MCP_SECRET_${Object.keys(env).length}`;
      env[variable] = value;
      return `${tomlKey(header)}=${JSON.stringify(variable)}`;
    });
    if (headers.length) args.push('-c', `${prefix}.env_http_headers={${headers.join(',')}}`);
  }
  return { args, env };
}

/** The servers in Amp's `--mcp-config` shape (its `amp.mcpServers` setting:
 * `{name: {command, args, env}}` or `{name: {url, headers}}`), which Amp merges
 * over its own settings for the one run. */
export function ampMcpConfig(servers: readonly McpServerSpec[]): Record<string, Json> {
  return Object.fromEntries(servers.map((server) => [server.name, server.transport === 'stdio'
    ? { command: server.command, args: [...server.args], ...(Object.keys(server.env).length ? { env: { ...server.env } } : {}) }
    : { url: server.url, ...(Object.keys(server.headers).length ? { headers: { ...server.headers } } : {}) }]));
}
