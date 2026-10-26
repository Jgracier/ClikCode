/** `conversations-mcp` and `swarm-mcp`, answered for any vendor config that still launches them.
 *
 * ClikCode no longer hands its own servers to a vendor (commit 6b528c86), and the leftover
 * entries are removed (harness/retired-mcp.ts). A copy that was missed used to meet an unknown
 * command, exit 1, and be restarted: a failing process every few minutes for as long as the
 * entry existed, and a red "MCP server failed" in the vendor's own screen. This is a valid MCP
 * server with nothing in it: it says so to the vendor, which stops asking, and it writes down
 * who launched it, so a missed copy is found in the log instead of by its failures.
 *
 * `npx-mcp` is not answered this way: it wrapped a real server of the user's, and an empty
 * answer would hide that it is gone. It keeps failing loudly until its entry is removed. */
import { createInterface } from 'node:readline';
import { lifecycle, parentProcessName } from '../runtime/lifecycle-log.js';

type Rpc = { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown> };
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export function answerRetiredMcp(message: Rpc, name: string): Record<string, unknown> | undefined {
  if (message.id === undefined) return undefined; // a notification wants no answer
  const reply = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id: message.id, result });
  switch (message.method) {
    case 'initialize': {
      const asked = String(message.params?.protocolVersion ?? '');
      return reply({ protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name, version: 'retired' } });
    }
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: [] });
    case 'resources/list': return reply({ resources: [] });
    case 'prompts/list': return reply({ prompts: [] });
    default: return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
  }
}

export async function serveRetiredMcp(name: string): Promise<void> {
  const parent = parentProcessName();
  lifecycle('mcp.retired.launch', { command: name, ...(parent ? { parent } : {}), ppid: process.ppid });
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message: Rpc;
    try { message = JSON.parse(line) as Rpc; } catch { return; }
    const response = answerRetiredMcp(message, name);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  });
  await new Promise<void>((resolve) => lines.once('close', resolve));
}
