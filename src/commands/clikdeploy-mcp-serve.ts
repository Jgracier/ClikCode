/** ClikDeploy's tools for a harness session, over stdio (`clikcode clikdeploy-mcp-serve`;
 * handed out by agent/mcp/clikdeploy-session.ts while this machine is signed in).
 *
 * A proxy of the platform's search-mode MCP server (`/mcp?toolmode=search`): the
 * same everyday core the Gateway agent is offered (gateway/mcp.ts) plus
 * `search_tools` (semantic search over every tool, each connected connector's
 * actions too) and `call_tool` (runs any of them). Each is renamed
 * `clikdeploy_<name>`, so none can collide with ClikCode's own tools in a
 * harness that does not namespace MCP tools.
 *
 * The key is read from the sign-in config on every call and is held only in
 * this process: a new sign-in takes effect on the next call, and a refused one
 * answers with how to sign in again instead of failing the session. Each call
 * tells the platform the chat's permission mode as it is now, so a bypass chat
 * is not asked a second time by the account's assistant mode. */
import { createInterface } from 'node:readline';
import { openTransport, type McpTransport } from '../agent/mcp/transport.js';
import { clikDeployConnection, type ClikDeployConnection } from '../agent/mcp/clikdeploy-session.js';
import { CLIKDEPLOY_CORE_TOOLS, PERMISSION_MODE_HEADER } from '../gateway/mcp.js';
import { untilInputEnds } from '../cli/stop-signal.js';
import { quiet } from '../runtime/lifecycle-log.js';

type Json = Record<string, any>;
type Rpc = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: Json };

const AREA = 'commands/clikdeploy-mcp-serve';
export const CLIKDEPLOY_TOOL_PREFIX = 'clikdeploy_';
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MODES = new Set(['ask', 'auto', 'bypass']);
/** A harness waits for the tool list before the session's first step; a slow or absent platform must not hold it. */
const LIST_WAIT_MS = 8_000;
/** A deploy through call_tool can run for minutes. */
const CALL_WAIT_MS = 10 * 60_000;

export const SIGN_IN_AGAIN = 'ClikDeploy refused the saved sign-in (it expired or was revoked). Sign in again with `clikdeploy login` or `clikcode gateway login`; the ClikDeploy tools use the new sign-in on their next call.';

/** Listed when the platform cannot be reached at session start: the two that reach everything, under stable names. */
const FALLBACK_TOOLS: readonly Json[] = [
  { name: 'search_tools', description: 'Search ClikDeploy\'s tools (platform actions and the actions of each connected connector, e.g. Gmail) by what you want to do. Returns tool names and their arguments for call_tool.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'What you want to do.' } }, required: ['query'] } },
  { name: 'call_tool', description: 'Run a ClikDeploy tool found with search_tools, by its exact name.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object' } }, required: ['name'] } },
];

export interface ClikDeployProxyOptions {
  connection?: () => ClikDeployConnection;
  /** The chat's permission mode now; undefined leaves it to the account's assistant mode. */
  permissionMode?: () => Promise<string | undefined>;
}

/** The permission mode of the chat whose worker started this process, as stored now (a /permissions change applies
 * to the next call); the turn's own CLIKDEPLOY_PERMISSION_MODE (turn-environment.ts) when the chat cannot be read. */
export async function chatPermissionMode(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const workerPid = Number(env.CLIKCODE_WORKER_PID);
  if (Number.isSafeInteger(workerPid) && workerPid > 0) {
    try {
      const { listWorkerRecords } = await import('../worker/registry.js');
      const sessionId = (await listWorkerRecords()).find((record) => record.pid === workerPid)?.sessionId;
      if (sessionId) {
        const { readState } = await import('../session/state/read.js');
        const mode = (await readState({ transcripts: [] })).sessions.find((session) => session.id === sessionId)?.permissionMode;
        if (mode && MODES.has(mode)) return mode;
      }
    } catch { /* fail-open-ok: the turn's own mode below */ }
  }
  const fromTurn = env.CLIKDEPLOY_PERMISSION_MODE;
  return fromTurn && MODES.has(fromTurn) ? fromTurn : undefined;
}

const refusedSignIn = (error: unknown): boolean => /HTTP 40[13]\b/.test(error instanceof Error ? error.message : String(error));

export function createClikDeployProxy(options: ClikDeployProxyOptions = {}): (message: Rpc) => Promise<Json | undefined> {
  const connect = options.connection ?? (() => clikDeployConnection());
  const permissionMode = options.permissionMode ?? (() => chatPermissionMode());
  let upstream: { transport: McpTransport; headers: Record<string, string>; key: string; url: string; ready: Promise<void> } | undefined;

  /** The open connection, for the current sign-in: a new key or URL opens a new one. */
  async function open(): Promise<{ transport: McpTransport; connection: ClikDeployConnection; headers: Record<string, string> }> {
    const connection = connect();
    if (!upstream || upstream.transport.closed || upstream.key !== connection.key || upstream.url !== connection.url) {
      void upstream?.transport.close().catch(quiet(AREA));
      const headers: Record<string, string> = { authorization: `Bearer ${connection.key}` };
      const transport = openTransport({ name: 'clikdeploy', transport: 'http', url: `${connection.url}/mcp?toolmode=search`, headers }, {});
      const ready = (async () => {
        const initialized = await transport.request('initialize', { protocolVersion: VERSIONS[0], capabilities: {}, clientInfo: { name: 'clikcode', version: '1' } }, { timeoutMs: LIST_WAIT_MS });
        if (typeof initialized.protocolVersion === 'string') transport.setProtocolVersion(initialized.protocolVersion);
        transport.notify('notifications/initialized');
      })();
      upstream = { transport, headers, key: connection.key, url: connection.url, ready };
    }
    const current = upstream;
    try { await current.ready; } catch (error) { if (upstream === current) upstream = undefined; void current.transport.close().catch(quiet(AREA)); throw error; }
    return { transport: current.transport, connection, headers: current.headers };
  }

  /** The headers of this call: the admin unlock and the chat's mode as they are now. */
  async function prepare(headers: Record<string, string>, connection: ClikDeployConnection): Promise<void> {
    const token = connection.config.get('adminMfaToken');
    if (typeof token === 'string' && token) headers['x-admin-mfa'] = token; else delete headers['x-admin-mfa'];
    const mode = await permissionMode().catch(quiet(AREA));
    if (mode) headers[PERMISSION_MODE_HEADER] = mode; else delete headers[PERMISSION_MODE_HEADER];
  }

  async function listTools(): Promise<Json[]> {
    try {
      const { transport, connection, headers } = await open();
      await prepare(headers, connection);
      const listed = await transport.request('tools/list', {}, { timeoutMs: LIST_WAIT_MS });
      const tools = (Array.isArray(listed.tools) ? listed.tools : []) as Json[];
      const core = tools.filter((tool) => CLIKDEPLOY_CORE_TOOLS.includes(String(tool.name)));
      // search_tools and call_tool are always there: a platform that left one out still gets the stable name.
      const missing = FALLBACK_TOOLS.filter((fallback) => !core.some((tool) => tool.name === fallback.name));
      return [...core, ...missing];
    } catch {
      // Not signed in, refused, or unreachable: the session starts anyway, and a call says why.
      return [...FALLBACK_TOOLS];
    }
  }

  async function callTool(name: string, args: Json): Promise<Json> {
    const text = (message: string): Json => ({ content: [{ type: 'text', text: message }], isError: true });
    // Not signed in: said plainly, with how to sign in.
    try { connect(); } catch (error) { return text(error instanceof Error ? error.message : String(error)); }
    for (let attempt = 0; ; attempt++) {
      try {
        const opened = await open();
        await prepare(opened.headers, opened.connection);
        return await opened.transport.request('tools/call', { name, arguments: args }, { timeoutMs: CALL_WAIT_MS });
      } catch (error) {
        if (refusedSignIn(error)) return text(SIGN_IN_AGAIN);
        // A connection the platform dropped (a forgotten session, a restart) is opened again once.
        if (attempt === 0 && upstream?.transport.closed !== false) { upstream = undefined; continue; }
        return text(`ClikDeploy could not run ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return async (message) => {
    if (message.id === undefined) return undefined; // a notification wants no answer
    const reply = (result: unknown): Json => ({ jsonrpc: '2.0', id: message.id, result });
    switch (message.method) {
      case 'initialize': {
        const asked = String(message.params?.protocolVersion ?? '');
        return reply({ protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: 'clikdeploy', version: '1' } });
      }
      case 'ping': return reply({});
      case 'tools/list':
        return reply({ tools: (await listTools()).map((tool) => ({ ...tool, name: `${CLIKDEPLOY_TOOL_PREFIX}${String(tool.name)}` })) });
      case 'tools/call': {
        const called = String(message.params?.name ?? '');
        if (!called.startsWith(CLIKDEPLOY_TOOL_PREFIX)) return { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `Unknown tool "${called}".` } };
        return reply(await callTool(called.slice(CLIKDEPLOY_TOOL_PREFIX.length), (message.params?.arguments ?? {}) as Json));
      }
      default: return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
    }
  };
}

/** Serves until the harness closes stdin or `signal` stops it, then finishes the calls in flight. */
export async function clikDeployMcpServe(signal?: AbortSignal): Promise<void> {
  const handle = createClikDeployProxy();
  const lines = createInterface({ input: process.stdin });
  const pending = new Set<Promise<void>>();
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message: Rpc;
    try { message = JSON.parse(line) as Rpc; } catch { return; }
    const work = handle(message).then((response) => { if (response) process.stdout.write(`${JSON.stringify(response)}\n`); }, () => undefined);
    pending.add(work);
    void work.finally(() => pending.delete(work));
  });
  await untilInputEnds(lines, signal);
  await Promise.allSettled([...pending]);
}
