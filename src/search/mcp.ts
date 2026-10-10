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
import { serveStdioMcp, toolServer } from '../harness/mcp-stdio-server.js';
import { resetCorpusCache } from './corpus.js';
import { resetSessionStoreCache } from '../session/store/records.js';
import { CONVERSATIONS_MCP_NAME } from './mcp-entry.js';
import { currentConversationSession } from '../worker/current-session.js';
import { CONVERSATION_TOOLS, CONVERSATION_TOOLS_NOTE, conversationTool, type ConversationToolContext } from './tools.js';

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
  const answer = toolServer({
    name: CONVERSATIONS_MCP_NAME,
    instructions: CONVERSATION_TOOLS_NOTE,
    tools: () => CONVERSATION_TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: { readOnlyHint: true } })),
    call: async (name, args) => {
      const tool = conversationTool(name);
      return tool ? tool.run(args, context) : undefined;
    },
  });
  return serveStdioMcp(async (message, send) => {
    try { return await answer(message, send); } finally { idle.touch(); }
  });
}
