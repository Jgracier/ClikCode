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
  failure?: { message: string; at: number };
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
    for (const state of this.servers.values()) {
      if (!state.client || !state.tools) {
        if (state.failure) notes.push(`MCP server "${state.spec.name}" is unavailable, so its tools are not offered: ${state.failure.message}`);
        continue;
      }
      for (const info of state.tools) {
        const name = mcpToolName(state.spec.name, info.name, taken);
        taken.add(name);
        tools.push(mcpToolDefinition(state.spec.name, info, name, (tool, args, signal) => this.call(state, tool, args, signal)));
      }
    }
    return { tools, notes };
  }

  /** Stops every server. Safe to call more than once. */
  async shutdown(): Promise<void> {
    const states = [...this.servers.values()];
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
        state.client = await McpClient.connect(state.spec, {
          timeoutMs: this.timeouts.connectMs,
          ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
          onNotification: (method) => { if (method === 'notifications/tools/list_changed') state.stale = true; },
        });
      }
      state.stale = false;
      state.tools = await state.client.listTools(this.timeouts.connectMs);
      state.failure = undefined;
    } catch (error) {
      state.failure = { message: firstLine(error), at: this.now() };
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

/** The process-wide manager for one state directory: what a turn builder
 * (the gateway route today, the local route next) calls for its extraTools.
 *
 * Under vitest with no CLIKCODE_HOME the answer is always empty, so a test
 * of the turn wiring never starts the developer's real servers. */
export async function mcpToolsForTurn(stateDir: string): Promise<McpToolset> {
  if (process.env.VITEST && !process.env.CLIKCODE_HOME?.trim()) return { tools: [], notes: [] };
  if (shared?.stateDir !== stateDir) {
    await shared?.manager.shutdown();
    shared = { stateDir, manager: new McpManager(() => loadMcpServers(stateDir)) };
  }
  try {
    return await shared.manager.toolset();
  } catch (error) {
    // Belt and braces: the manager catches per server, but MCP must never be
    // the reason a turn did not run.
    return { tools: [], notes: [`MCP tools are unavailable this turn: ${firstLine(error)}`] };
  }
}
