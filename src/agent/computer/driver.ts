/** One supervised Cua MCP connection for the lifetime of this ClikCode process.
 * The connection owns Cua's implicit session and closes with the process. */
import { McpClient, type McpCallResult } from '../mcp/client.js';

let pending: Promise<McpClient> | undefined;
let connected: McpClient | undefined;

function start(): Promise<McpClient> {
  if (connected && !connected.closed) return Promise.resolve(connected);
  if (pending) return pending;
  pending = McpClient.connect(
    { name: 'clikcode-computer', transport: 'stdio', command: 'cua-driver', args: ['mcp', '--direct'], env: {} },
    { timeoutMs: 15_000 },
  ).then((client) => {
    connected = client;
    process.once('exit', () => client.killNow());
    return client;
  }).finally(() => { pending = undefined; });
  return pending;
}

export async function callComputerDriver(
  tool: string, args: Record<string, unknown>, signal?: AbortSignal,
): Promise<McpCallResult> {
  const client = await start();
  return client.callTool(tool, args, { timeoutMs: 45_000, signal });
}
