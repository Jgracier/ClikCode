/** `clikcode conversations-mcp`: the conversation tools as a stdio MCP
 * server, for vendor agents. ClikCode installs it into each harness the way
 * it installs every other MCP server (harness/provision.ts), so Claude Code,
 * Codex, Gemini and the rest can see the user's other conversations too.
 * Read-only: it reads the index and transcripts and never writes.
 *
 * The conversation the vendor is running is left out by default; which one
 * that is comes from worker/current-session.ts, with no stored state. */

import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { serveStdioMcp } from '../harness/mcp-stdio-server.js';
import { resetCorpusCache } from './corpus.js';
import { resetSessionStoreCache } from '../session/store/records.js';
import { CONVERSATIONS_MCP_NAME } from './mcp-entry.js';
import { currentConversationSession } from '../worker/current-session.js';
import { CONVERSATION_TOOLS, CONVERSATION_TOOLS_NOTE, conversationTool, type ConversationToolContext } from './tools.js';

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string };
}

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export async function answerMcp(message: RpcMessage, context: ConversationToolContext): Promise<unknown | undefined> {
  if (!message.method || message.id === undefined || message.id === null) return undefined;
  const respond = (result: unknown) => ({ jsonrpc: '2.0', id: message.id, result });
  if (message.method === 'initialize') {
    const asked = message.params?.protocolVersion;
    return respond({
      protocolVersion: asked && SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
      capabilities: { tools: {} },
      serverInfo: { name: CONVERSATIONS_MCP_NAME, version: '1' },
      instructions: CONVERSATION_TOOLS_NOTE,
    });
  }
  if (message.method === 'ping') return respond({});
  if (message.method === 'tools/list') {
    return respond({
      tools: CONVERSATION_TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: { readOnlyHint: true } })),
    });
  }
  if (message.method === 'tools/call') {
    const tool = conversationTool(message.params?.name ?? '');
    if (!tool) return { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `Unknown tool ${message.params?.name ?? ''}` } };
    try {
      const result = await tool.run(message.params?.arguments ?? {}, context);
      return respond({ content: [{ type: 'text', text: result.text }], ...(result.isError ? { isError: true } : {}) });
    } catch (error) {
      return respond({ content: [{ type: 'text', text: `${tool.name} failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true });
    }
  }
  if (message.method === 'resources/list') return respond({ resources: [] });
  if (message.method === 'prompts/list') return respond({ prompts: [] });
  return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
}

/** How long the server keeps every transcript's text after its last
 * request. The vendor keeps this process for the whole session, and a
 * searched corpus is ~100 MB that a session asking once an hour should not
 * hold; reading it again costs ~120 ms. Memory only: the cache's validity
 * never depends on a clock (corpus.ts). */
export const CORPUS_IDLE_MS = 3 * 60_000;

/** Calls `release` once `idleMs` pass without a `touch`. The timer never
 * keeps the process alive. */
export function idleRelease(release: () => void, idleMs: number): { touch(): void } {
  let timer: NodeJS.Timeout | undefined;
  return {
    touch() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; release(); }, idleMs);
      timer.unref();
    },
  };
}

/** Drops the corpus -- the indexed text and the parsed session files it
 * was read from -- and returns its pages to the system. Dropping alone
 * frees nothing visible: an idle process allocates nothing, so V8 never
 * collects, and an ordinary collection keeps the 64 MB young generation the
 * search grew. The last-resort flavour shrinks it (measured: 169 -> 66 MB;
 * 53 MB fresh). */
function releaseCorpus(): void {
  resetCorpusCache();
  resetSessionStoreCache();
  try {
    setFlagsFromString('--expose-gc');
    (runInNewContext('gc') as (options: object) => void)({ type: 'major', execution: 'sync', flavor: 'last-resort' });
  } catch { /* fail-open-ok: the memory is then freed by the next collection instead. */ }
}

/** Stdio MCP, answered in whichever framing the client used. */
export function serveConversationsMcp(): Promise<void> {
  const context: ConversationToolContext = {};
  const current = currentConversationSession();
  if (current) context.currentSessionId = current;
  const idle = idleRelease(releaseCorpus, CORPUS_IDLE_MS);
  return serveStdioMcp(async (message) => {
    try { return await answerMcp(message as RpcMessage, context); } finally { idle.touch(); }
  });
}
