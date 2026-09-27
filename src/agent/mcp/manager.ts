/** The MCP servers this ClikCode process is connected to, and the tools they
 * offer a turn.
 *
 * Lifetime is the PROCESS, not the turn. A stdio server is often `npx -y …`,
 * which costs seconds to start; paying that on every turn would make each
 * prompt visibly slower, and a server with state (a browser, a database
 * connection) would lose it between turns. So a server starts on the first
 * turn that wants tools, stays up, and is killed when the process exits.
 *
 * The config file is re-read on every turn -- it is one small file -- so a
 * server added with `clikcode mcp add` is picked up by the next turn, one
 * whose entry changed is restarted, and one removed is shut down.
 *
 * No server can fail a turn. One that will not start, crashes, or times out
 * simply offers no tools this turn, and the caller is handed a note saying
 * which and why. A failed start is retried, but not on every turn: a server
 * that takes the whole connect timeout to fail would otherwise add that wait
 * to every prompt.
 */
import type { ToolDefinition } from '../tool-contract.js';
import { McpClient, type McpCallResult, type McpToolInfo } from './client.js';
import { loadMcpServers, type McpServerSpec } from './config.js';
import { importNotice, importVendorMcpServers } from './import.js';
import { mcpToolDefinition, mcpToolName } from './tools.js';

export interface McpTimeouts {
  /** Spawn + initialize + tools/list. Generous: `npx -y` may download first. */
  connectMs: number;
  callMs: number;
  /** How long a server that failed to start is left alone before retrying. */
  retryAfterMs: number;
}

const DEFAULT_TIMEOUTS: McpTimeouts = { connectMs: 30_000, callMs: 300_000, retryAfterMs: 60_000 };

export interface McpToolset {
  tools: ToolDefinition[];
  /** One line per server that is configured but offers nothing this turn. */
  notes: string[];
}

interface ServerState {
  spec: McpServerSpec;
  key: string;
  client?: McpClient;
  tools?: McpToolInfo[];
  connecting?: Promise<void>;
  /** Set by `notifications/tools/list_changed`; the next turn re-lists. */
  stale?: boolean;
  failure?: { message: string; at: number; reported?: boolean };
  /** Shut down or removed from the config. A start still in flight when that
   * happened must not leave a server behind: it closes what it started. */
  retired?: boolean;
  /** Aborts a start in flight, killing the server it spawned. */
  starting?: AbortController;
}

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 3).join(' | ').slice(0, 300);
}

export class McpManager {
  private readonly servers = new Map<string, ServerState>();
  private readonly timeouts: McpTimeouts;
  private exitHookInstalled = false;
  private readonly killAll = (): void => { for (const state of this.servers.values()) state.client?.killNow(); };

  constructor(
    private readonly loadServers: () => Promise<{ servers: McpServerSpec[]; problem?: string }>,
    options: { timeouts?: Partial<McpTimeouts>; fetchImpl?: typeof fetch; now?: () => number } = {},
  ) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.fetchImpl = options.fetchImpl;
    this.now = options.now ?? Date.now;
  }

  private readonly fetchImpl?: typeof fetch;
  private readonly now: () => number;

  /** The tools every configured server offers right now. Servers connect in
   * parallel, so the slowest one bounds the wait, not the sum of them. */
  async toolset(): Promise<McpToolset> {
    const { servers, problem } = await this.loadServers();
    const notes: string[] = problem ? [problem] : [];
    await this.reconcile(servers);
    await Promise.all([...this.servers.values()].map((state) => this.ensureReady(state)));
    const tools: ToolDefinition[] = [];
    const taken = new Set<string>();
    // By name, not by connection order: a server restarted or reconnected
    // would otherwise move, changing the tool list and with it the prompt
    // prefix every cache depends on.
    const ordered = [...this.servers.values()].sort((a, b) => (a.spec.name < b.spec.name ? -1 : a.spec.name > b.spec.name ? 1 : 0));
    for (const state of ordered) {
      if (!state.client || !state.tools) {
        // Said once per failure, not on every turn: a server that stays down
        // (one needing a login the agent cannot do) would otherwise add the
        // same line to every conversation. A different reason is said again.
        if (state.failure && !state.failure.reported) {
          notes.push(`MCP server "${state.spec.name}" is unavailable, so its tools are not offered: ${state.failure.message}`);
          state.failure.reported = true;
        }
        continue;
      }
      for (const info of state.tools) {
        const name = mcpToolName(state.spec.name, info.name, taken);
        taken.add(name);
        tools.push(mcpToolDefinition(state.spec.name, info, name, (tool, args, signal) => this.call(state, tool, args, signal), state.spec.core?.includes(info.name) ?? false));
      }
    }
    return { tools, notes };
  }

  /** Stops every server. Safe to call more than once. */
  async shutdown(): Promise<void> {
    const states = [...this.servers.values()];
    for (const state of states) { state.retired = true; state.starting?.abort(); }
    this.servers.clear();
    process.off('exit', this.killAll);
    this.exitHookInstalled = false;
    await Promise.all(states.map((state) => this.stop(state)));
  }

  private async reconcile(specs: readonly McpServerSpec[]): Promise<void> {
    const wanted = new Map(specs.map((spec) => [spec.name, spec]));
    const stopping: Promise<void>[] = [];
    for (const [name, state] of this.servers) {
      const spec = wanted.get(name);
      if (spec && JSON.stringify(spec) === state.key) continue;
      state.retired = true;
      state.starting?.abort();
      this.servers.delete(name);
      stopping.push(this.stop(state));
    }
    for (const spec of specs) {
      if (!this.servers.has(spec.name)) this.servers.set(spec.name, { spec, key: JSON.stringify(spec) });
    }
    await Promise.all(stopping);
  }

  private async stop(state: ServerState): Promise<void> {
    const client = state.client;
    state.client = undefined;
    state.tools = undefined;
    await client?.close().catch(() => undefined);
  }

  private ensureReady(state: ServerState): Promise<void> {
    if (state.connecting) return state.connecting;
    // A server that crashed between turns is simply started again; if that
    // start fails, the failure backoff below applies from then on.
    if (state.client?.closed) {
      state.client = undefined;
      state.tools = undefined;
      state.failure = undefined;
    }
    if (state.client && state.tools && !state.stale) return Promise.resolve();
    if (!state.client && state.failure && this.now() - state.failure.at < this.timeouts.retryAfterMs) return Promise.resolve();
    state.connecting = this.connect(state).finally(() => { state.connecting = undefined; });
    return state.connecting;
  }

  private async connect(state: ServerState): Promise<void> {
    try {
      if (!state.client) {
        this.installExitHook();
        state.starting = new AbortController();
        const client = await McpClient.connect(state.spec, {
          signal: state.starting.signal,
          timeoutMs: this.timeouts.connectMs,
          ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
          onNotification: (method) => { if (method === 'notifications/tools/list_changed') state.stale = true; },
        });
        // Shut down while it was starting: nothing owns it any more, and the
        // exit hook that would have killed it is gone -- close it now.
        state.starting = undefined;
        if (state.retired) { await client.close().catch(() => undefined); return; }
        state.client = client;
      }
      state.stale = false;
      state.tools = await state.client.listTools(this.timeouts.connectMs);
      if (state.retired) { await this.stop(state); return; }
      state.failure = undefined;
    } catch (error) {
      state.starting = undefined;
      const message = firstLine(error);
      state.failure = { message, at: this.now(), reported: state.failure?.message === message && state.failure.reported };
      await this.stop(state);
    }
  }

  /** A call to a server that died since its tools were listed gets one
   * reconnect before failing: the model already chose this tool, and a
   * restart is cheaper than a wasted step. */
  private async call(state: ServerState, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    if (!state.client || state.client.closed) {
      state.client = undefined;
      state.failure = undefined;
      await this.ensureReady(state);
    }
    const client = state.client;
    if (!client) throw new Error(`MCP server "${state.spec.name}" is not running: ${state.failure?.message ?? 'it could not be started'}`);
    return client.callTool(tool, args, { timeoutMs: this.timeouts.callMs, ...(signal ? { signal } : {}) });
  }

  /** Stdio servers are their own process group (see transport.ts), so
   * nothing else reaps them if ClikCode exits; `exit` handlers must be
   * synchronous, which is why this kills rather than shutting down politely. */
  private installExitHook(): void {
    if (this.exitHookInstalled) return;
    this.exitHookInstalled = true;
    process.once('exit', this.killAll);
  }
}

let shared: { stateDir: string; manager: McpManager } | undefined;
let imports: Promise<string | undefined> | undefined;
/** Servers the route brings with it (the Gateway's own ClikDeploy server),
 * beside the user's mcp.json. The latest caller's list: the config is re-read
 * every turn, so a route change adds or stops them like an edited file. */
let builtinServers: readonly McpServerSpec[] = [];

/** The user's servers and the route's built-ins; a server the user configured
 * under the same name wins. */
async function loadAllServers(stateDir: string): Promise<{ servers: McpServerSpec[]; problem?: string }> {
  const loaded = await loadMcpServers(stateDir);
  const names = new Set(loaded.servers.map((server) => server.name));
  return { ...loaded, servers: [...loaded.servers, ...builtinServers.filter((server) => !names.has(server.name))] };
}

/** The process-wide manager for one state directory: what a turn builder
 * (the gateway route today, the local route next) calls for its extraTools.
 *
 * Under vitest with no CLIKCODE_HOME the answer is always empty, so a test
 * of the turn wiring never starts the developer's real servers. */
export async function mcpToolsForTurn(stateDir: string, signal?: AbortSignal, builtins: readonly McpServerSpec[] = []): Promise<McpToolset> {
  if (process.env.VITEST && !process.env.CLIKCODE_HOME?.trim()) return { tools: [], notes: [] };
  builtinServers = builtins;
  if (!signal) return sharedToolset(stateDir);
  // A cancel while a slow server is still starting ends the wait at once;
  // the start carries on in the background and serves the next turn.
  return new Promise((resolve) => {
    const onAbort = (): void => resolve({ tools: [], notes: [] });
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    void sharedToolset(stateDir).then(resolve).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function sharedToolset(stateDir: string): Promise<McpToolset> {
  if (shared?.stateDir !== stateDir) {
    await shared?.manager.shutdown();
    shared = { stateDir, manager: new McpManager(() => loadAllServers(stateDir)) };
    imports = undefined;
  }
  // Before the first load, once per process and state directory: the servers
  // the user gave their vendor harnesses before mcp.json existed. Once it has
  // run anywhere, its marker file makes this a single read.
  imports ??= importVendorMcpServers(stateDir).then(importNotice, (error: unknown) => `MCP import from harness configs failed: ${firstLine(error)}`);
  const notice = await imports;
  imports = Promise.resolve(undefined); // the notice is shown once, not every turn
  try {
    const toolset = await shared.manager.toolset();
    return notice ? { ...toolset, notes: [notice, ...toolset.notes] } : toolset;
  } catch (error) {
    // Belt and braces: the manager catches per server, but MCP must never be
    // the reason a turn did not run.
    return { tools: [], notes: [`MCP tools are unavailable this turn: ${firstLine(error)}`] };
  }
}

/** Start this state directory's servers now, rather than on the first turn:
 * a conversation that has just chosen an agent route will want them, and
 * `npx -y` servers take seconds. Never throws; a server that will not start
 * is reported by the turn that wanted it, as before. */
export function prepareMcp(stateDir: string, builtins: readonly McpServerSpec[] = []): void {
  if (process.env.VITEST && !process.env.CLIKCODE_HOME?.trim()) return;
  builtinServers = builtins;
  void sharedToolset(stateDir).catch(() => undefined);
}

/** Stop every server this process started: the conversation left the agent
 * route, or nobody is attached to it any more. The next turn that wants
 * tools starts them again. */
export async function releaseMcp(): Promise<void> {
  builtinServers = [];
  const current = shared;
  shared = undefined;
  imports = undefined;
  await current?.manager.shutdown();
}

