/** `clikcode connectors agent-mcp`: the MCP server the headless micro-task agent is given. It serves browser_use and account_use only, runs them
 * in this process in the one tab it was started with (the agent cannot name another, so it never touches the default tab), and counts calls:
 * past the budget a call is refused with the instruction to give a RESULT line. The count is written to a file for the caller's log. */
import { quiet } from '../../runtime/lifecycle-log.js';
import { createInterface } from 'node:readline';
import { untilInputEnds } from '../../cli/stop-signal.js';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { stateDirectory } from '../../session/store/paths.js';
import type { ToolContext, ToolDefinition } from '../tool-contract.js';
import { scrubSecrets } from './secret-scrubber.js';

type Rpc = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: Record<string, any> };
export interface AgentMcpOptions { tab: string; maxCalls: number; counter?: string; tools?: readonly ToolDefinition[]; stateDir?: string; connector?: string }

export const CONNECTOR_TASK_TOOLS = ['connector_spec_get', 'connector_spec_put', 'connector_discover', 'connector_build', 'connector_build_apply', 'connector_copy_task', 'connector_copy_apply', 'connector_proof', 'connector_finish', 'connector_seed_plan', 'connector_seed_apply', 'connector_spec_patch', 'connector_enrich', 'connector_onboard', 'connector_work_note', 'connector_scope_check', 'connector_test', 'connector_test_job_status', 'connector_test_job_step', 'connector_harvest_fixtures'] as const;

/** Each micro-task can edit only its own connector through validated platform tools. No audiences or gate settings surface here. */
export function connectorTaskTool(id: string, ports?: { describe(tool: string): Promise<unknown>; call(tool: string, args: Record<string, unknown>): Promise<unknown> }): ToolDefinition {
  return {
    name: 'connector_task', class: 'write',
    description: `Research, build from official documentation, or finish the assigned connector ${id}. The id is fixed by the worker. Read the platform task before making changes; Use tool=describe with args.tool to read the exact argument schema before an unfamiliar operation. Save progress with connector_work_note. copy_task supplies wording slots. Never invent live proof.`,
    parameters: { type: 'object', properties: { tool: { type: 'string', enum: ['describe', ...CONNECTOR_TASK_TOOLS], description: 'The bounded connector operation to call.' }, args: { type: 'object', description: 'Operation arguments; id is supplied by the worker.', additionalProperties: true } }, required: ['tool'] },
    label: () => `Work on ${id}`,
    async run(input) {
      const describe = input.tool === 'describe';
      const describedArgs = input.args && typeof input.args === 'object' ? input.args as Record<string, unknown> : {};
      const target = describe ? describedArgs.tool : input.tool;
      if (!CONNECTOR_TASK_TOOLS.includes(target as typeof CONNECTOR_TASK_TOOLS[number])) throw new Error('This connector operation is not available to the micro-task.');
      const args = input.args && typeof input.args === 'object' && !Array.isArray(input.args) ? input.args as Record<string, unknown> : {};
      if (args.id !== undefined && args.id !== id) throw new Error('The micro-task may only work on its assigned connector.');
      let result: unknown;
      if (describe) {
        if (ports) result = await ports.describe(String(target));
        else {
          const { runCli } = await import('./run-cli.js');
          const { unwrapTool } = await import('./connector-runner-live.js');
          const run = await runCli('clikdeploy', ['tools', 'describe', String(target)], { timeoutMs: 20_000 });
          if (run.missing) throw new Error('The clikdeploy command is not installed.');
          result = unwrapTool(run.text);
        }
      } else {
        const { liveClient, WORKER } = await import('./connector-runner-live.js');
        const scoped = { ...args, id, ...(target === 'connector_work_note' || target === 'connector_onboard' ? { worker: WORKER } : {}) };
        result = ports ? await ports.call(String(target), scoped) : await liveClient().tool(String(target), scoped);
      }
      return { output: scrubSecrets(JSON.stringify(result)) };
    },
  };
}

export function agentMcpHandler(options: AgentMcpOptions): (message: Rpc) => Promise<Record<string, unknown> | undefined> {
  let calls = 0;
  const load = async (): Promise<readonly ToolDefinition[]> => {
    if (options.tools) return options.tools;
    const { accountUseTool, browserUseTool } = await import('../tools/computer-web.js');
    const tools = [browserUseTool, accountUseTool] as unknown as ToolDefinition[];
    if (options.connector) tools.push(connectorTaskTool(options.connector));
    return tools;
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
        if (options.counter) await writeFile(options.counter, String(calls)).catch(quiet('agent/computer/connector-micro-agent-mcp'));
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

/** Serves until stdin closes or `signal` stops it, then closes its tab; the caller exits after (mcp-serve.ts). */
export async function agentMcpServe(options: AgentMcpOptions, signal?: AbortSignal): Promise<void> {
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
  await untilInputEnds(lines, signal);
  await Promise.allSettled([...pending]);
  const { closeComputerPage, releaseComputerBrowser } = await import('./browser.js');
  await closeComputerPage(options.stateDir ?? stateDirectory(), options.tab).catch(quiet('agent/computer/connector-micro-agent-mcp'));
  await releaseComputerBrowser(options.stateDir ?? stateDirectory()).catch(quiet('agent/computer/connector-micro-agent-mcp'));
}
