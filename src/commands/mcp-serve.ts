/** ClikCode's own MCP server (`clikcode mcp-serve`), over stdio. It is handed to
 * every harness session automatically (harness/transport/acp-mcp-servers.ts),
 * so the conversation tools (search/tools.ts: search_conversations,
 * read_conversation, active_conversations, hindsight), and computer use and
 * secret capture while computer use is on, work in any harness, not only
 * ClikCode's agent. It holds no state: a computer call is forwarded to the
 * chat's worker, and a conversation tool reads the stored conversations, as
 * the chat whose worker started this process. */
import { createInterface } from 'node:readline';
import { installedBuildStamp, latestToolSet } from '../agent/computer/hot-tools.js';
import { computerEnabled } from '../agent/computer/settings.js';
import type { ToolDefinition } from '../agent/tool-contract.js';
import { stateDirectory } from '../session/store/paths.js';
import { CONVERSATION_TOOLS, CONVERSATION_TOOLS_NOTE } from '../search/tools.js';
import type { callWorkerTool } from './computer-tool-client.js';
import { currentToolName } from '../agent/computer/tool-names.js';
import { untilInputEnds } from '../cli/stop-signal.js';
import { quiet } from '../runtime/lifecycle-log.js';
import { DEFER_COMPUTER_TOOLS_ENV } from '../agent/mcp/config.js';

type Rpc = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: Record<string, any> };
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** The tool list of the installed build, not of the code this process started with: a rebuilt ClikCode changes arguments. */
async function toolSet(): Promise<readonly ToolDefinition[]> {
  // The built copy (dist/computer-tools.js) is one file; the program's own copy is the whole computer
  // implementation in many, so it is loaded only where there is no built copy (tests, a source checkout).
  return await latestToolSet() ?? (await import('../worker/computer-tool.js')).SHARED_COMPUTER_TOOLS;
}

/** Computer tools only while computer use is on (`clikcode computer off`); the conversation tools always. */
async function computerTools(): Promise<readonly ToolDefinition[]> {
  return await computerEnabled(stateDirectory()) ? toolSet() : [];
}

/** The loader that stands in for the computer tools until the model asks for them. Their schemas are
 * about 7k tokens, in every request of every session, and most turns never use them. */
export const LOAD_COMPUTER_TOOLS = 'load_computer_tools';
/** The computer tools are listed: the harness does not re-read tool lists, or the model loaded them. */
let computerListed = process.env[DEFER_COMPUTER_TOOLS_ENV] !== '1';
/** The tool list changed since the client last read it: it is told (mcpServe). */
let listChanged = false;
/** Lists the computer tools from now on, and has the client told. */
function listComputerTools(): void { if (!computerListed) { computerListed = true; listChanged = true; } }
export function takeListChanged(): boolean { const changed = listChanged; listChanged = false; return changed; }
/** For tests: as a session of a harness that re-reads tool lists starts. */
export function deferComputerTools(defer: boolean): void { computerListed = !defer; listChanged = false; }

const firstSentence = (text: string): string => text.split(/\n|\. /)[0]!.slice(0, 90);

async function tools(): Promise<unknown[]> {
  const computer = await computerTools();
  const listed = computerListed || !computer.length ? computer.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })) : [{
    name: LOAD_COMPUTER_TOOLS,
    description: `Load the computer tools before using one; they are listed after this call. ${computer.map(tool => `${tool.name}: ${firstSentence(tool.description)}`).join('; ')}.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }];
  return [...CONVERSATION_TOOLS.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })), ...listed];
}

/** The worker connection, loaded with the first call: a session that never calls a tool does not pay for it. */
const callInWorker: typeof callWorkerTool = async (input) => (await import('./computer-tool-client.js')).callWorkerTool(input);
/** The chat this server answers for: the one whose worker started it. */
const chatOfWorker = async (): Promise<string | undefined> => (await import('./computer-tool-client.js')).workerChat();

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

export async function handleMcpRequest(message: Rpc, call = callInWorker, chat = chatOfWorker): Promise<Record<string, unknown> | undefined> {
  if (message.id === undefined) return undefined; // a notification wants no answer
  const reply = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id: message.id, result });
  switch (message.method) {
    case 'initialize': {
      const asked = String(message.params?.protocolVersion ?? '');
      return reply({ protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0], capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'clikcode', version: '1' }, instructions: CONVERSATION_TOOLS_NOTE });
    }
    case 'ping': return reply({});
    case 'tools/list': { listedStamp = await installedBuildStamp(); return reply({ tools: await tools() }); }
    case 'tools/call': {
      const name = currentToolName(String(message.params?.name ?? ''));
      if (name === LOAD_COMPUTER_TOOLS) {
        const computer = await computerTools();
        if (!computer.length) return reply({ content: [{ type: 'text', text: 'Computer use is off (clikcode computer on turns it on).' }], isError: true });
        listComputerTools();
        return reply({ content: [{ type: 'text', text: `Loaded ${computer.map(tool => tool.name).join(', ')}: they are in your tool list now.` }], isError: false });
      }
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      const conversationTool = CONVERSATION_TOOLS.find(tool => tool.name === name);
      if (conversationTool) {
        try {
          const currentSessionId = await chat().catch(quiet('commands/mcp-serve'));
          const result = await conversationTool.run(args, currentSessionId ? { currentSessionId } : {});
          return reply({ content: [{ type: 'text', text: result.text }], isError: Boolean(result.isError) });
        } catch (error) {
          return reply({ content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true });
        }
      }
      // A computer tool is known whether computer use is on or not: off, the worker refuses it in plain words.
      if (!(await toolSet()).some(tool => tool.name === name)) return { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `Unknown tool "${name}".` } };
      listComputerTools(); // called by name without loading: list it from now on
      try {
        const result = await call({ tool: name, args });
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

/** Serves until the harness closes stdin or `signal` stops it (untilStopped: SIGTERM, SIGINT, SIGHUP), then
 * finishes the calls in flight. The caller exits after: the worker connection would otherwise keep the
 * process alive, and a harness that has to kill it leaves a start with no end in the lifecycle log. */
export async function mcpServe(signal?: AbortSignal): Promise<void> {
  const lines = createInterface({ input: process.stdin });
  const pending = new Set<Promise<void>>();
  lines.on('line', line => {
    if (!line.trim()) return;
    let message: Rpc;
    try { message = JSON.parse(line) as Rpc; } catch { return; }
    const work = handleMcpRequest(message).then(async response => {
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      // Computer tools just loaded, or a newer installed build: tell the client to ask for the tool list again.
      if (takeListChanged() || await buildChangedSinceListed()) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n`);
    });
    pending.add(work);
    void work.finally(() => pending.delete(work));
  });
  await untilInputEnds(lines, signal);
  await Promise.allSettled([...pending]);
}
