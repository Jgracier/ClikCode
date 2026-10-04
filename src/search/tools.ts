/** The three conversation tools, once, for every agent: ClikCode's own
 * (agent/tools/conversations.ts wraps them as native tools) and every vendor
 * harness (search/mcp.ts serves them over MCP). Read-only.
 *
 * The conversation the agent is asking from is left out unless it asks for
 * it: it already has that one. */

import { activeConversations } from './active.js';
import { conversationGroups, conversationTitle, findConversation, type ConversationGroup } from './conversations.js';
import { conversationView, type ConversationView } from './corpus.js';
import { parseSince, searchConversations, type ConversationHit } from './engine.js';
import { ago, duration, hitSnippets, mentionCount, parseAnchor, renderFullMessage, renderMessage, runsOn, shortId } from './format.js';
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

const IN_SNIPPETS = 20;

const searchTool: ConversationTool = {
  name: 'search_conversations',
  description: 'Search the user\'s other ClikCode conversations (every provider: Claude, Codex, Gemini, ClikCode\'s own agent, …) by words or a phrase, including the tool calls they ran. Use it whenever the user mentions other work, another chat or agent, or something "we discussed" that is not in this conversation. Returns the best-matching conversations, each with its id, title, provider, when it was last active, how many mentions it has (of the exact phrase, or else of messages holding all the words -- it says which), and up to 3 snippets of those mentions with anchors like "6e647d75:60" (conversation id : message number); pass one as `at` to read_conversation for the surrounding messages. A conversation whose title is the query ranks first, then titles holding every word, then the exact phrase, then all the words; recent conversations rank higher. Pass `in` (a conversation id) to list where inside that one conversation the query comes up (up to 20 anchors; works for the current conversation too).',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['query'],
    properties: {
      query: { type: 'string', description: 'Words or a phrase, case-insensitive, e.g. "token refresh retry".' },
      in: { type: 'string', description: 'Search only this conversation (an id from a result, or the current one): returns up to 20 anchors in it.' },
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
    const within = typeof args.in === 'string' && args.in.trim() ? args.in.trim() : undefined;
    let scope: { conversationId?: string; excludeConversationId?: string; excludeSessionId?: string };
    if (within) {
      const found = findConversation(await conversationGroups(), within);
      if (!found) return { text: `No conversation "${within}". Use an id from search_conversations or active_conversations.`, isError: true };
      scope = { conversationId: found.group.id };
    } else scope = await excluded(context, args.includeCurrent);
    const limit = integer(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const result = await searchConversations(query, { ...scope, ...(sinceMs !== undefined ? { sinceMs } : {}), now });
    if (!result) return { text: 'search_conversations needs a query.', isError: true };
    const phrase = maskSecrets(result.query.text);
    if (!result.hits.length) return { text: within ? `"${phrase}" does not come up in ${within}.` : `No conversation mentions "${phrase}" (searched ${result.searched}).` };
    const words = result.query.words.length;
    const describe = (hit: ConversationHit): string => [
      `${maskSecrets(hit.title)} — id ${shortId(hit.conversationId)}`, runsOn(hit), ago(hit.updatedAtMs, now),
      ...(hit.titleMatch ? [hit.titleMatch === 'exact' ? 'title is the query' : 'title has every word'] : []), mentionCount(hit, words),
    ].join(' · ');
    if (within) {
      const hit = result.hits[0]!;
      const view = await conversationView(findConversation(await conversationGroups(), hit.conversationId)!.group);
      const snippets = hitSnippets(hit, view, IN_SNIPPETS);
      const messages = new Set(hit.mentions.map((mention) => mention.position)).size;
      const more = messages > snippets.length ? [`(${messages - snippets.length} more message${messages - snippets.length === 1 ? '' : 's'}; read_conversation(id, at) around the last anchor shows what follows)`] : [];
      return { text: [`"${phrase}" in ${describe(hit)}. read_conversation(id, at) opens an anchor.`, ...snippets.map((line) => `  ${line}`), ...more].join('\n') };
    }
    const shown = result.hits.slice(0, limit);
    const groups = new Map((await conversationGroups()).map((group) => [group.id, group]));
    const lines = [`"${phrase}": ${result.hits.length} conversation${result.hits.length === 1 ? '' : 's'} (searched ${result.searched})${result.hits.length > shown.length ? `, best ${shown.length} shown` : ''}. read_conversation(id, at) opens one at an anchor; search_conversations(query, in=id) lists every place in one.`];
    for (const [rank, hit] of shown.entries()) {
      lines.push(`${rank + 1}. ${describe(hit)}`);
      const group = groups.get(hit.conversationId);
      if (group) for (const line of hitSnippets(hit, await conversationView(group))) lines.push(`   ${line}`);
    }
    return { text: lines.join('\n') };
  },
};

/** Where an anchor points in a conversation's merged numbering. One that
 * names the conversation (its id is also its first chat's) is a merged
 * number already; one naming another of its chats, as results printed them
 * before, is that chat's own index. */
function resolveAnchor(anchor: { session?: string; messageIndex: number }, group: ConversationGroup, view: ConversationView, groups: readonly ConversationGroup[]): number | undefined {
  const session = anchor.session?.toLowerCase();
  if (!session || group.id.toLowerCase().startsWith(session)) return anchor.messageIndex;
  const named = findConversation(groups, session);
  if (named?.group.id !== group.id || !named.branch) return undefined;
  return view.positions.get(named.branch.id)?.[anchor.messageIndex];
}

const readTool: ConversationTool = {
  name: 'read_conversation',
  description: 'Read part of another ClikCode conversation: its messages and compacted tool calls around an anchor from search_conversations (`at`, e.g. "6e647d75:14" or a message number), or its latest turns when `at` is omitted. Widen before/after (or move `at`) to page through it. Long messages are shortened ("[… 441 chars]"); `full: true` reads the one message at `at` whole, with every tool call\'s output. Output is bounded by maxChars.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['id'],
    properties: {
      id: { type: 'string', description: 'A conversation id (or its first 8 characters) from search_conversations or active_conversations.' },
      at: { type: 'string', description: 'Anchor: "<conversation>:<message>" from a snippet (e.g. "6e647d75:14"), or a message number ("14").' },
      before: { type: 'integer', minimum: 0, maximum: 50, description: 'Messages before the anchor (default 2; without an anchor, how many of the latest messages, default 6).' },
      after: { type: 'integer', minimum: 0, maximum: 50, description: 'Messages after the anchor (default 2).' },
      full: { type: 'boolean', description: 'Read only the message at `at` (the latest without one), whole: nothing shortened but at maxChars.' },
      maxChars: { type: 'integer', minimum: 500, maximum: MAX_READ_CHARS, description: `Most characters to return (default ${DEFAULT_READ_CHARS}).` },
    },
  },
  async run(args, context) {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) return { text: 'read_conversation needs an id.', isError: true };
    const groups = await conversationGroups();
    const anchor = args.at === undefined || args.at === null || args.at === '' ? undefined : parseAnchor(args.at);
    if (args.at !== undefined && args.at !== null && args.at !== '' && !anchor) return { text: `Cannot read at="${String(args.at)}". Use an anchor like "6e647d75:14" or a message number.`, isError: true };
    const found = findConversation(groups, id) ?? (anchor?.session ? findConversation(groups, anchor.session) : undefined);
    if (!found) return { text: `No conversation "${id}". Use an id from search_conversations or active_conversations.`, isError: true };
    const group = found.group;
    const view = await conversationView(group);
    const entries = view.entries;
    const now = context.now ?? Date.now();
    const newest = group.newest;
    const header = `${maskSecrets(conversationTitle(newest))} — id ${shortId(group.id)} · ${runsOn({ provider: newest.provider ?? null, model: newest.model ?? null, ...(newest.nativeHarness ? { harness: newest.nativeHarness } : {}) })} · ${ago(group.updatedAtMs, now)} · ${view.mainLength} messages${entries.length > view.mainLength ? ` (+${entries.length - view.mainLength} in other branches, #${view.mainLength}–${entries.length - 1})` : ''}`;
    if (!entries.length) return { text: `${header}\n(no saved messages)` };
    const at = anchor ? resolveAnchor(anchor, group, view, groups) : undefined;
    if (anchor && at === undefined) return { text: `${header}\nThere is no message ${String(args.at)} in it.`, isError: true };
    if (at !== undefined && at >= entries.length) return { text: `${header}\nThere is no message ${at}; the last is ${entries.length - 1}.`, isError: true };
    const maxChars = integer(args.maxChars, DEFAULT_READ_CHARS, 500, MAX_READ_CHARS);
    if (args.full === true) {
      const index = at ?? view.mainLength - 1;
      return { text: [header, renderFullMessage(index, entries[index]!.message, Math.max(200, maxChars - header.length - 1))].join('\n') };
    }
    let from: number;
    let to: number;
    if (at !== undefined) {
      from = Math.max(0, at - integer(args.before, 2, 0, 50));
      to = Math.min(entries.length - 1, at + integer(args.after, 2, 0, 50));
    } else {
      to = Math.max(0, view.mainLength - 1);
      from = Math.max(0, to - integer(args.before, 6, 1, 50) + 1);
    }
    const count = to - from + 1;
    // The anchor's message gets a larger share: it is what was asked for.
    const focusShare = at !== undefined ? Math.floor(maxChars * (count > 1 ? 0.45 : 0.9)) : 0;
    const otherShare = Math.floor((maxChars - focusShare - header.length - 200) / Math.max(1, at !== undefined ? count - 1 : count));
    const blocks: string[] = [];
    const shortened: number[] = [];
    for (let index = from; index <= to; index += 1) {
      const entry = entries[index]!;
      if (entry.forkAfter !== undefined) {
        const branch = group.branches.find((item) => item.id === entry.sessionId);
        const who = branch ? ` (${runsOn({ provider: branch.provider ?? null, model: branch.model ?? null, ...(branch.nativeHarness ? { harness: branch.nativeHarness } : {}) })})` : '';
        blocks.push(entry.forkAfter < 0 ? `— another branch of it${who}, from the start —` : `— another branch of it${who}, continuing from #${entry.forkAfter} —`);
      }
      const rendered = renderMessage(index, entry.message, index === at ? focusShare : otherShare);
      if (rendered.shortened) shortened.push(index);
      blocks.push(rendered.text);
    }
    const more: string[] = [];
    if (from > 0) more.push(`earlier: at=${from - 1}`);
    if (to < entries.length - 1) more.push(`later: at=${to + 1}`);
    const notes = [
      ...(more.length ? [`(more — ${more.join(' · ')})`] : []),
      ...(shortened.length ? [`(shortened: #${shortened.join(', #')}; at=N full=true reads one whole)`] : []),
    ];
    return { text: [header, `messages ${from}–${to}:`, ...blocks, ...notes].join('\n') };
  },
};

const activeTool: ConversationTool = {
  name: 'active_conversations',
  description: 'What the user\'s other ClikCode conversations are doing right now: each one that is working, open, or active in the last 2 hours, with its provider, when it was last active, the user\'s last request, how long a running turn has been going and its current step, and whether it is waiting for the user\'s approval. Use it when the user asks about other agents, what is running, or work happening elsewhere.',
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
      const active = `last active ${ago(item.updatedAtMs, now)}`;
      const state = item.state === 'working'
        ? `working${item.turnStartedAt ? ` for ${duration(now - Date.parse(item.turnStartedAt))}` : ''} · ${active}`
        : item.state === 'open' ? `open, idle · ${active}` : active;
      const head = `- ${maskSecrets(item.title)} — id ${shortId(item.conversationId)} · ${runsOn(item)} · ${state}`;
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
