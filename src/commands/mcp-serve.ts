/** ClikCode's own MCP server (`clikcode mcp-serve`), over stdio. It is handed to
 * every harness session automatically (harness/transport/acp-mcp-servers.ts),
 * so computer use and secret capture work in any harness, not only ClikCode's
 * agent. It holds no state: each call is forwarded to the chat's worker. */
import { createInterface } from 'node:readline';
import { SHARED_COMPUTER_TOOLS } from '../worker/computer-tool.js';
import { installedBuildStamp, latestTool } from '../agent/computer/hot-tools.js';
import { callWorkerTool } from './computer-tool-client.js';
import { currentToolName } from '../agent/computer/tool-names.js';

type Rpc = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: Record<string, any> };
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** The tool list of the installed build, not of the code this process started with: a rebuilt ClikCode changes arguments. */
async function tools(): Promise<unknown[]> {
  return Promise.all(SHARED_COMPUTER_TOOLS.map(async tool => { const fresh = await latestTool(tool.name) ?? tool; return { name: tool.name, description: fresh.description, inputSchema: fresh.parameters }; }));
}

/** The installed build as of the last tool list this process gave out. */
let listedStamp: number | undefined;
let toldStamp: number | undefined;

/** True once per newer installed build: the caller's cached tool list is out of date. */
export async function buildChangedSinceListed(): Promise<boolean> {
  const now = await installedBuildStamp();
  if (now === undefined || listedStamp === undefined || now === listedStamp || now === toldStamp) return false;
  toldStamp = now;
  return true;
}

export async function handleMcpRequest(message: Rpc, call = callWorkerTool): Promise<Record<string, unknown> | undefined> {
  if (message.id === undefined) return undefined; // a notification wants no answer
  const reply = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id: message.id, result });
  switch (message.method) {
    case 'initialize': {
      const asked = String(message.params?.protocolVersion ?? '');
      return reply({ protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0], capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'clikcode', version: '1' } });
    }
    case 'ping': return reply({});
    case 'tools/list': { listedStamp = await installedBuildStamp(); return reply({ tools: await tools() }); }
    case 'tools/call': {
      const name = currentToolName(String(message.params?.name ?? ''));
      if (!SHARED_COMPUTER_TOOLS.some(tool => tool.name === name)) return { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `Unknown tool "${name}".` } };
      try {
        const result = await call({ tool: name, args: (message.params?.arguments ?? {}) as Record<string, unknown> });
        // A rejected call after a rebuild is most likely the caller's cached tool list: say so, and say what to do.
        const stale = !result.ok && /^Invalid arguments/.test(result.output) && await installedBuildStamp() !== listedStamp;
        const text = stale ? `${result.output}\nrestart needed: the installed ClikCode build is newer than the tool list this session was given; start a new chat (or reconnect the clikcode MCP server) to get the new arguments.` : result.output;
        return reply({ content: [{ type: 'text', text }], isError: !result.ok });
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
    const work = handleMcpRequest(message).then(async response => {
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      // A newer installed build: tell the client to ask for the tool list again.
      if (await buildChangedSinceListed()) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n`);
    });
    pending.add(work);
    void work.finally(() => pending.delete(work));
  });
  await new Promise<void>(resolve => lines.once('close', resolve));
  await Promise.allSettled([...pending]);
}
