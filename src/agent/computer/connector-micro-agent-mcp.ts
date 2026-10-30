/** `clikcode connectors agent-mcp`: the MCP server the headless micro-task agent is given. It serves browser_use and account_use only, runs them
 * in this process in the one tab it was started with (the agent cannot name another, so it never touches the default tab), and counts calls:
 * past the budget a call is refused with the instruction to give a RESULT line. The count is written to a file for the caller's log. */
import { createInterface } from 'node:readline';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { stateDirectory } from '../../session/store/paths.js';
import type { ToolContext, ToolDefinition } from '../tool-contract.js';
import { scrubSecrets } from './secret-scrubber.js';

type Rpc = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: Record<string, any> };
export interface AgentMcpOptions { tab: string; maxCalls: number; counter?: string; tools?: readonly ToolDefinition[]; stateDir?: string }

export function agentMcpHandler(options: AgentMcpOptions): (message: Rpc) => Promise<Record<string, unknown> | undefined> {
  let calls = 0;
  const load = async (): Promise<readonly ToolDefinition[]> => {
    if (options.tools) return options.tools;
    const { accountUseTool, browserUseTool } = await import('../tools/computer-web.js');
    return [browserUseTool, accountUseTool] as unknown as ToolDefinition[];
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
        if (calls >= options.maxCalls) return reply({ content: [{ type: 'text', text: `Call budget of ${options.maxCalls} used. Stop now and end with your RESULT line.` }], isError: true });
        calls++;
        if (options.counter) await writeFile(options.counter, String(calls)).catch(() => undefined);
        try {
          // The tab is ours, whatever the agent passes.
          const args = { ...(message.params?.arguments ?? {}), tab: options.tab } as Record<string, unknown>;
          const stateDir = options.stateDir ?? stateDirectory();
          const context = { cwd: process.cwd(), stateDir, homeDir: homedir(), emitOutput: () => undefined } as unknown as ToolContext;
          const result = await tool.run(args as never, context);
          return reply({ content: [{ type: 'text', text: scrubSecrets(result.output) }], isError: !!result.isError });
        } catch (error) {
          return reply({ content: [{ type: 'text', text: scrubSecrets(error instanceof Error ? error.message : String(error)) }], isError: true });
        }
      }
      default: return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
    }
  };
}

export async function agentMcpServe(options: AgentMcpOptions): Promise<void> {
  const handle = agentMcpHandler(options);
  const lines = createInterface({ input: process.stdin });
  const pending = new Set<Promise<void>>();
  lines.on('line', line => {
    let message: Rpc;
    try { message = JSON.parse(line) as Rpc; } catch { return; }
    const work = handle(message).then(response => { if (response) process.stdout.write(`${JSON.stringify(response)}\n`); });
    pending.add(work);
    void work.finally(() => pending.delete(work));
  });
  await new Promise<void>(resolve => lines.once('close', resolve));
  await Promise.allSettled([...pending]);
  const { closeComputerPage, releaseComputerBrowser } = await import('./browser.js');
  await closeComputerPage(options.stateDir ?? stateDirectory(), options.tab).catch(() => undefined);
  await releaseComputerBrowser(options.stateDir ?? stateDirectory()).catch(() => undefined);
}
