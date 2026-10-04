/** The three conversation tools, once, for every agent: ClikCode's own
 * (agent/tools/conversations.ts wraps them as native tools) and every vendor
 * harness (search/mcp.ts serves them over MCP). Read-only.
 *
 * The conversation the agent is asking from is left out unless it asks for
 * it: it already has that one. */

import { activeConversations } from './active.js';
import { conversationGroups, conversationTitle, findConversation } from './conversations.js';
import { sessionDoc } from './corpus.js';
import { parseSince, searchConversations, type Mention } from './engine.js';
import { ago, hitSnippets, parseAnchor, renderMessage, runsOn, shortId } from './format.js';
import { maskSecrets } from './secrets.js';

export interface ConversationToolContext {
  /** The chat the calling agent is in, when known. */
  currentSessionId?: string;
  now?: number;
}

export interface ConversationToolResult { text: string; isError?: boolean }

export interface ConversationTool {
  name: 'search_conversations' | 'read_conversation' | 'active_conversations';
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>, context: ConversationToolContext): Promise<ConversationToolResult>;
}

/** One line for the instructions an agent is given. */
export const CONVERSATION_TOOLS_NOTE = 'The user\'s other ClikCode conversations (with any provider) are searchable: when they refer to other work, another chat or another agent, use search_conversations, read_conversation and active_conversations rather than guessing or asking them to paste it.';

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const DEFAULT_READ_CHARS = 8000;
const MAX_READ_CHARS = 40_000;

const integer = (value: unknown, fallback: number, min: number, max: number): number => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
};

async function excluded(context: ConversationToolContext, includeCurrent: unknown): Promise<{ excludeConversationId?: string; excludeSessionId?: string }> {
  if (includeCurrent === true || !context.currentSessionId) return {};
  const found = findConversation(await conversationGroups(), context.currentSessionId);
  return { excludeSessionId: context.currentSessionId, ...(found ? { excludeConversationId: found.group.id } : {}) };
}

const searchTool: ConversationTool = {
  name: 'search_conversations',
  description: 'Search the user\'s other ClikCode conversations (every provider: Claude, Codex, Gemini, ClikCode\'s own agent, …) by words or a phrase, including the tool calls they ran. Use it whenever the user mentions other work, another chat or agent, or something "we discussed" that is not in this conversation. Returns the best-matching conversations, each with its id, title, provider, when it was last active, how many mentions it has, and up to 3 snippets with anchors; pass an id and anchor to read_conversation for the surrounding messages. The exact phrase ranks above conversations that only contain all the words; recent conversations rank higher.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['query'],
    properties: {
      query: { type: 'string', description: 'Words or a phrase, case-insensitive, e.g. "token refresh retry".' },
      since: { type: 'string', description: 'Only conversations active since then: "2d", "12h", "1w", or a date.' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Conversations to return (default ${DEFAULT_LIMIT}).` },
      includeCurrent: { type: 'boolean', description: 'Also search the conversation you are in (left out by default).' },
    },
  },
  async run(args, context) {
    const query = typeof args.query === 'string' ? args.query : '';
    if (!query.trim()) return { text: 'search_conversations needs a query.', isError: true };
    const now = context.now ?? Date.now();
    const sinceMs = parseSince(typeof args.since === 'string' ? args.since : undefined, now);
    if (typeof args.since === 'string' && args.since.trim() && sinceMs === undefined) return { text: `Cannot read since="${args.since}". Use "2d", "12h", "1w" or a date.`, isError: true };
    const limit = integer(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const result = await searchConversations(query, { ...await excluded(context, args.includeCurrent), ...(sinceMs !== undefined ? { sinceMs } : {}), now });
    if (!result) return { text: 'search_conversations needs a query.', isError: true };
    if (!result.hits.length) return { text: `No conversation mentions "${maskSecrets(result.query.text)}" (searched ${result.searched}).` };
    const shown = result.hits.slice(0, limit);
    const lines = [`"${maskSecrets(result.query.text)}": ${result.hits.length} conversation${result.hits.length === 1 ? '' : 's'} (searched ${result.searched})${result.hits.length > shown.length ? `, best ${shown.length} shown` : ''}. read_conversation(id, at) opens one at an anchor.`];
    for (const [rank, hit] of shown.entries()) {
      const docs = new Map<string, Awaited<ReturnType<typeof sessionDoc>>>();
      for (const mention of hit.mentions.slice(0, 12)) if (!docs.has(mention.sessionId)) docs.set(mention.sessionId, await sessionDoc(mention.sessionId));
      const mentions = `${hit.mentions.length} mention${hit.mentions.length === 1 ? '' : 's'}${hit.exactCount ? '' : ' (all words, not the exact phrase)'}`;
      lines.push(`${rank + 1}. ${maskSecrets(hit.title)} — id ${shortId(hit.conversationId)} · ${runsOn(hit)} · ${ago(hit.updatedAtMs, now)} · ${mentions}`);
      for (const line of hitSnippets(hit, (mention: Mention) => docs.get(mention.sessionId)?.messages[mention.messageIndex])) lines.push(`   ${line}`);
    }
    return { text: lines.join('\n') };
  },
};

const readTool: ConversationTool = {
  name: 'read_conversation',
  description: 'Read part of another ClikCode conversation: its messages and compacted tool calls around an anchor from search_conversations (`at`, e.g. "5c41f2c9:14" or a message number), or its latest turns when `at` is omitted. Widen before/after (or move `at`) to page through it. Output is bounded by maxChars.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['id'],
    properties: {
      id: { type: 'string', description: 'A conversation id (or its first 8 characters) from search_conversations or active_conversations.' },
      at: { type: 'string', description: 'Anchor: "<chat>:<message>" from a snippet (e.g. "5c41f2c9:14"), or a message number ("14").' },
      before: { type: 'integer', minimum: 0, maximum: 50, description: 'Messages before the anchor (default 2; without an anchor, how many of the latest messages, default 6).' },
      after: { type: 'integer', minimum: 0, maximum: 50, description: 'Messages after the anchor (default 2).' },
      maxChars: { type: 'integer', minimum: 500, maximum: MAX_READ_CHARS, description: `Most characters to return (default ${DEFAULT_READ_CHARS}).` },
    },
  },
  async run(args, context) {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) return { text: 'read_conversation needs an id.', isError: true };
    const groups = await conversationGroups();
    const anchor = args.at === undefined || args.at === null || args.at === '' ? undefined : parseAnchor(args.at);
    if (args.at !== undefined && args.at !== null && args.at !== '' && !anchor) return { text: `Cannot read at="${String(args.at)}". Use an anchor like "5c41f2c9:14" or a message number.`, isError: true };
    const found = findConversation(groups, anchor?.session ?? id) ?? findConversation(groups, id);
    if (!found) return { text: `No conversation "${id}". Use an id from search_conversations or active_conversations.`, isError: true };
    const branch = (anchor?.session ? findConversation(groups, anchor.session)?.branch : undefined) ?? found.branch ?? found.group.newest;
    const doc = await sessionDoc(branch.id);
    const messages = doc?.messages ?? [];
    const now = context.now ?? Date.now();
    const header = `${maskSecrets(conversationTitle(found.group.newest))} — id ${shortId(found.group.id)} · chat ${shortId(branch.id)} · ${runsOn({ provider: branch.provider ?? null, model: branch.model ?? null, ...(branch.nativeHarness ? { harness: branch.nativeHarness } : {}) })} · ${ago(found.group.updatedAtMs, now)} · ${messages.length} messages`;
    if (!messages.length) return { text: `${header}\n(no saved messages)` };
    let from: number;
    let to: number;
    if (anchor) {
      if (anchor.messageIndex >= messages.length) return { text: `${header}\nThere is no message ${anchor.messageIndex}; the last is ${messages.length - 1}.`, isError: true };
      from = Math.max(0, anchor.messageIndex - integer(args.before, 2, 0, 50));
      to = Math.min(messages.length - 1, anchor.messageIndex + integer(args.after, 2, 0, 50));
    } else {
      to = messages.length - 1;
      from = Math.max(0, to - integer(args.before, 6, 1, 50) + 1);
    }
    const maxChars = integer(args.maxChars, DEFAULT_READ_CHARS, 500, MAX_READ_CHARS);
    const count = to - from + 1;
    // The anchor's message gets a larger share: it is what was asked for.
    const focusShare = anchor ? Math.floor(maxChars * (count > 1 ? 0.45 : 0.9)) : 0;
    const otherShare = Math.floor((maxChars - focusShare - header.length - 200) / Math.max(1, anchor ? count - 1 : count));
    const blocks: string[] = [];
    for (let index = from; index <= to; index += 1) {
      const isFocus = anchor?.messageIndex === index;
      blocks.push(renderMessage(index, messages[index]!, isFocus ? focusShare : otherShare));
    }
    const more: string[] = [];
    if (from > 0) more.push(`earlier: at=${from - 1}`);
    if (to < messages.length - 1) more.push(`later: at=${to + 1}`);
    return { text: [header, `messages ${from}–${to}:`, ...blocks, ...(more.length ? [`(more — ${more.join(' · ')})`] : [])].join('\n') };
  },
};

const activeTool: ConversationTool = {
  name: 'active_conversations',
  description: 'What the user\'s other ClikCode conversations are doing right now: each one that is working, open, or active in the last 2 hours, with its provider, the user\'s last request, the current step of a running turn, and whether it is waiting for the user\'s approval. Use it when the user asks about other agents, what is running, or work happening elsewhere.',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      includeCurrent: { type: 'boolean', description: 'Also list the conversation you are in (left out by default).' },
    },
  },
  async run(args, context) {
    const now = context.now ?? Date.now();
    const list = await activeConversations({ ...await excluded(context, args.includeCurrent), now });
    if (!list.length) return { text: 'No other conversation is working, open, or active in the last 2 hours.' };
    const lines = list.map((item) => {
      const head = `- ${maskSecrets(item.title)} — id ${shortId(item.conversationId)} · ${runsOn(item)} · ${item.state === 'working' ? `working${item.turnStartedAt ? ` for ${ago(Date.parse(item.turnStartedAt), now).replace(' ago', '')}` : ''}` : item.state === 'open' ? 'open, idle' : `last active ${ago(item.updatedAtMs, now)}`}`;
      const parts = [head];
      if (item.awaitingApproval) parts.push(`  WAITING FOR APPROVAL: ${maskSecrets(item.awaitingApproval.title)} (since ${ago(Date.parse(item.awaitingApproval.since), now)})`);
      if (item.lastAsk) parts.push(`  asked: ${maskSecrets(item.lastAsk)}`);
      if (item.step) parts.push(`  now: ${maskSecrets(item.step)}`);
      for (const agent of item.subagents ?? []) parts.push(`  sub-agent: ${maskSecrets(agent)}`);
      return parts.join('\n');
    });
    return { text: [`${list.length} conversation${list.length === 1 ? '' : 's'} (read_conversation(id) shows the latest turns):`, ...lines].join('\n') };
  },
};

export const CONVERSATION_TOOLS: readonly ConversationTool[] = [searchTool, readTool, activeTool];

export function conversationTool(name: string): ConversationTool | undefined {
  return CONVERSATION_TOOLS.find((tool) => tool.name === name);
}
