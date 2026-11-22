/** `clikcode computer mcp`: ClikCode's computer tools (browser_use, account_use) as a bounded MCP server over stdio, for a headless agent
 * or a script. Every call runs in this process in the ONE tab it was started with (a caller cannot name another, so the default tab is
 * never touched), leaves through the egress it was given, and counts against a call budget: past it a call is refused with the
 * instruction to stop. Addresses matching a blocked pattern are refused before they open, and a page that redirects into one is left at
 * once and not shown. When the input ends the tab is closed. */
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { quiet } from '../../runtime/lifecycle-log.js';
import { untilInputEnds } from '../../cli/stop-signal.js';
import { stateDirectory } from '../../session/store/paths.js';
import type { ToolContext, ToolDefinition } from '../tool-contract.js';
import { scrubSecrets } from '../computer/secret-scrubber.js';
import { withFileLock } from '../../session/store/locks.js';
import { ACTIVITY_ENV, MAX_CALLS_ENV, markActivity, readActivity } from './activity.js';

type Rpc = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: Record<string, any> };
export interface ComputerMcpOptions {
  tab: string;
  /** The call budget. With an activity file it is shared with the other servers that write to it. */ maxCalls: number;
  /** The shared activity file (activity.ts). Default: CLIKCODE_AGENT_ACTIVITY. */ activity?: string;
  tools?: readonly ToolDefinition[]; stateDir?: string;
  /** The way out the tab's pages leave through (egress.ts). */ egress?: string;
  /** Addresses never opened (regular expressions, case-insensitive), and what the caller is told instead. */
  blockUrls?: readonly string[]; blockMessage?: string;
  /** Binds the tab to the egress (browser.ts bindTabEgress); tests give a fake. */ bindEgress?: (stateDir: string, tab: string, egress: string) => Promise<void>;
}

/** Whether a call opens, or a result shows, an address matching one of `patterns`. */
export function blockedAddress(patterns: readonly RegExp[], args: Record<string, unknown>, output = ''): boolean {
  if (!patterns.length) return false;
  const url = typeof args.url === 'string' ? args.url.trim() : '';
  const shown = /^(?:[^\n]*\n){0,8}?Page: (\S+)/.exec(output)?.[1] ?? '';
  return patterns.some(pattern => (url && pattern.test(url)) || (shown && pattern.test(shown)));
}

export function computerMcpHandler(options: ComputerMcpOptions): (message: Rpc) => Promise<Record<string, unknown> | undefined> {
  let calls = 0;
  let bound: Promise<void> | undefined;
  const activity = options.activity ?? process.env[ACTIVITY_ENV];
  const patterns = (options.blockUrls ?? []).map(source => new RegExp(source, 'i'));
  const refusal = options.blockMessage ?? 'Refused: this address is not open to this run.';
  const bindEgress = (stateDir: string): Promise<void> => {
    if (!options.egress || options.egress === 'home') return Promise.resolve();
    bound ??= (options.bindEgress ? options.bindEgress(stateDir, options.tab, options.egress) : import('../computer/browser.js').then(browser => browser.bindTabEgress(stateDir, options.tab, options.egress)));
    return bound;
  };
  const load = async (): Promise<readonly ToolDefinition[]> => {
    if (options.tools) return options.tools;
    const { accountUseTool, browserUseTool } = await import('../tools/computer-web.js');
    return [browserUseTool, accountUseTool] as unknown as ToolDefinition[];
  };
  // Checking the budget and taking a call are one step: two calls at once (or two servers sharing the activity file) cannot
  // both see the last call free. The activity file's lock covers every server on it; without one the count is in this process.
  const takeCall = async (): Promise<boolean> => {
    if (!activity) { if (calls >= options.maxCalls) return false; calls++; return true; }
    return withFileLock(`${activity}.lock`, async () => {
      if ((await readActivity(activity)).started >= options.maxCalls) return false;
      calls++;
      await markActivity(activity, '+');
      return true;
    });
  };
  return async message => {
    if (message.id === undefined) return undefined;
    const reply = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id: message.id, result });
    switch (message.method) {
      case 'initialize': return reply({ protocolVersion: String(message.params?.protocolVersion ?? '2025-06-18'), capabilities: { tools: {} }, serverInfo: { name: 'clikcode', version: '1' } });
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: (await load()).map(t => ({ name: t.name, description: t.description, inputSchema: t.parameters })) });
      case 'tools/call': {
        const name = String(message.params?.name ?? '');
        const tool = (await load()).find(t => t.name === name);
        if (!tool) return { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `Unknown tool "${name}".` } };
        if (!await takeCall()) return reply({ content: [{ type: 'text', text: `Call budget of ${options.maxCalls} used. Stop now and give your final answer.` }], isError: true });
        try {
          // The tab is ours, whatever the caller passes.
          const args = { ...(message.params?.arguments ?? {}), tab: options.tab } as Record<string, unknown>;
          const stateDir = options.stateDir ?? stateDirectory();
          const context = { cwd: process.cwd(), stateDir, homeDir: homedir(), emitOutput: () => undefined } as unknown as ToolContext;
          if (blockedAddress(patterns, args)) return reply({ content: [{ type: 'text', text: refusal }], isError: true });
          await bindEgress(stateDir);
          const result = await tool.run(args as never, context);
          // A page that redirected into a blocked address is left at once and not shown.
          if (blockedAddress(patterns, {}, result.output)) {
            await tool.run({ action: 'open', url: 'about:blank', tab: options.tab } as never, context).catch(quiet('agent/headless/computer-mcp'));
            return reply({ content: [{ type: 'text', text: refusal }], isError: true });
          }
          return reply({ content: [{ type: 'text', text: scrubSecrets(result.output) }], isError: !!result.isError });
        } catch (error) {
          return reply({ content: [{ type: 'text', text: scrubSecrets(error instanceof Error ? error.message : String(error)) }], isError: true });
        } finally { await markActivity(activity, '.'); }
      }
      default: return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
    }
  };
}

/** How long calls still running may finish once the server is told to stop, before its tab is closed. */
export const STOP_DRAIN_MS = 3_000;

/** Serves until stdin closes or `signal` stops it, then closes its tab; the caller exits after. */
export async function serveComputerMcp(options: ComputerMcpOptions, signal?: AbortSignal): Promise<void> {
  const handle = computerMcpHandler(options);
  const lines = createInterface({ input: process.stdin });
  const pending = new Set<Promise<void>>();
  lines.on('line', line => {
    let message: Rpc;
    try { message = JSON.parse(line) as Rpc; } catch { return; }
    const work = handle(message).then(response => { if (response) process.stdout.write(`${JSON.stringify(response)}\n`); });
    pending.add(work);
    void work.finally(() => pending.delete(work));
  });
  await untilInputEnds(lines, signal);
  // Told to stop (SIGTERM from the agent runner, which SIGKILLs after a grace period): a call still running -- a captcha solve, a
  // texted-code wait -- gets a moment, then the tab is closed anyway rather than left open by the kill that follows.
  const drained = Promise.allSettled([...pending]);
  await (signal?.aborted ? Promise.race([drained, new Promise(resolve => setTimeout(resolve, STOP_DRAIN_MS).unref())]) : drained);
  const { closeComputerPage, releaseComputerBrowser } = await import('../computer/browser.js');
  await closeComputerPage(options.stateDir ?? stateDirectory(), options.tab).catch(quiet('agent/headless/computer-mcp'));
  await releaseComputerBrowser(options.stateDir ?? stateDirectory()).catch(quiet('agent/headless/computer-mcp'));
}

export const maxCallsFromEnv = (): number | undefined => { const n = Number(process.env[MAX_CALLS_ENV]); return Number.isInteger(n) && n > 0 ? n : undefined; };
