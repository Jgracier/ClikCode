/** ClikCode's own MCP server (`clikcode mcp-serve`), over stdio. It is handed to
 * every harness session automatically (harness/transport/acp-mcp-servers.ts),
 * so computer use and secret capture work in any harness, not only ClikCode's
 * agent. It holds no state: each call is forwarded to the chat's worker. */
import { createInterface } from 'node:readline';
import { SHARED_COMPUTER_TOOLS } from '../worker/computer-tool.js';
import { callWorkerTool } from './computer-tool-client.js';

type Rpc = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: Record<string, any> };
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

function tools(): unknown[] {
  return SHARED_COMPUTER_TOOLS.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters }));
}

export async function handleMcpRequest(message: Rpc, call = callWorkerTool): Promise<Record<string, unknown> | undefined> {
  if (message.id === undefined) return undefined; // a notification wants no answer
  const reply = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id: message.id, result });
  switch (message.method) {
    case 'initialize': {
      const asked = String(message.params?.protocolVersion ?? '');
      return reply({ protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: 'clikcode', version: '1' } });
    }
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: tools() });
    case 'tools/call': {
      const name = String(message.params?.name ?? '');
      if (!SHARED_COMPUTER_TOOLS.some(tool => tool.name === name)) return { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `Unknown tool "${name}".` } };
      try {
        const result = await call({ tool: name, args: (message.params?.arguments ?? {}) as Record<string, unknown> });
        return reply({ content: [{ type: 'text', text: result.output }], isError: !result.ok });
      } catch (error) {
        return reply({ content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true });
      }
    }
    default: return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
  }
}

export async function mcpServe(): Promise<void> {
  const lines = createInterface({ input: process.stdin });
  const pending = new Set<Promise<void>>();
  lines.on('line', line => {
    if (!line.trim()) return;
    let message: Rpc;
    try { message = JSON.parse(line) as Rpc; } catch { return; }
    const work = handleMcpRequest(message).then(response => { if (response) process.stdout.write(`${JSON.stringify(response)}\n`); });
    pending.add(work);
    void work.finally(() => pending.delete(work));
  });
  await new Promise<void>(resolve => lines.once('close', resolve));
  await Promise.allSettled([...pending]);
}
