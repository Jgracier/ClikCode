/** The conversation tools, once, for every agent: ClikCode's own
 * (agent/tools/conversations.ts wraps them as native tools) and every vendor
 * harness (search/mcp.ts serves them over MCP). Read-only.
 *
 * Search, read, and active leave out the conversation the agent is asking
 * from unless it asks for that one: it already has it. Hindsight is that
 * conversation and no other. */

import { readTurnActivities } from '../turn/turn-activities.js';
import type { HarnessSession } from '../session/model.js';
import { loadIndex } from '../session/state/index-file.js';
import { stateDirectory } from '../session/store/paths.js';
import { readSessionTranscript } from '../session/store/transcripts.js';
import { readTurnChanges } from '../session/turn-changes.js';
import { activeConversations } from './active.js';
import { conversationGroups, conversationTitle, findConversation, type ConversationGroup } from './conversations.js';
import { conversationView, type ConversationView } from './corpus.js';
import { parseSince, searchConversations, type ConversationHit } from './engine.js';
import { ago, duration, hitSnippets, mentionCount, parseAnchor, renderFullMessage, renderMessage, runsOn, shortId } from './format.js';
import { oneLine, presentTopics, rangeLabel, topicsBefore, type HindsightMessage, type PresentedTopic } from './hindsight.js';
import { maskSecrets } from './secrets.js';

export interface ConversationToolContext {
  /** The chat the calling agent is in, when known. */
  currentSessionId?: string;
  now?: number;
}

export interface ConversationToolResult { text: string; isError?: boolean }

export interface ConversationTool {
  name: 'search_conversations' | 'read_conversation' | 'active_conversations' | 'hindsight';
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>, context: ConversationToolContext): Promise<ConversationToolResult>;
}

/** One line for the instructions an agent is given: the system prompt of
 * ClikCode's own agent, the MCP server's instructions for vendors. When to
 * reach for the tools is said here, once; each description says only what
 * its tool does, and the anchor format is described once, on search. */
export const CONVERSATION_TOOLS_NOTE = 'The user\'s other ClikCode conversations (any provider) are searchable: when they mention other work, another chat or agent, use search_conversations, read_conversation and active_conversations instead of guessing or asking them to paste it. What this chat was doing before is hindsight, which reads only this conversation.';

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const DEFAULT_READ_CHARS = 8000;
const MAX_READ_CHARS = 40_000;

/** A caller that must fill every field (strict function calling, which hosted
 * models through the Gateway use) sends the type's zero for one it has nothing
 * to say about: "", 0, false. A count that cannot be 0 (limit, maxChars,
 * before, after) is then not given, and takes its default -- not its minimum,
 * which turned a search into one hit and a read into 500 characters. */
const integer = (value: unknown, fallback: number, min: number, max: number): number => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(number) || number === 0) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
};

async function excluded(context: ConversationToolContext, includeCurrent: unknown): Promise<{ excludeConversationId?: string; excludeSessionId?: string }> {
  if (includeCurrent === true || !context.currentSessionId) return {};
  const found = findConversation(await conversationGroups(), context.currentSessionId);
  return { excludeSessionId: context.currentSessionId, ...(found ? { excludeConversationId: found.group.id } : {}) };
}

const IN_SNIPPETS = 20;

const searchTool: ConversationTool = {
  name: 'search_conversations',
  description: 'Search the user\'s other ClikCode conversations (every provider, tool calls included) by words or a phrase. Returns the best matches: id, title, provider, last active, mention count, and up to 3 snippets with anchors "<id>:<message>" (e.g. "6e647d75:60") to pass to read_conversation as `at`. Title matches rank first, then the exact phrase, then all words; recent ranks higher. With `in`, lists up to 20 anchors inside that one conversation.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['query'],
    properties: {
      query: { type: 'string', description: 'Words or a phrase, case-insensitive.' },
      in: { type: 'string', description: 'A conversation id (the current one too): search only inside it.' },
      since: { type: 'string', description: 'Only conversations active since: "2d", "12h", "1w" or a date.' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Default ${DEFAULT_LIMIT}.` },
      includeCurrent: { type: 'boolean', description: 'Include the conversation you are in.' },
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
  description: 'Read another conversation\'s messages and compacted tool calls around `at`, or its latest turns without it. Page with before/after or by moving `at`. Long messages are shortened; full=true reads the message at `at` whole, tool output included.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['id'],
    properties: {
      id: { type: 'string', description: 'Conversation id (its first 8 characters suffice).' },
      at: { type: 'string', description: 'An anchor ("6e647d75:14") or a message number ("14").' },
      before: { type: 'integer', minimum: 1, maximum: 50, description: 'Messages before `at` (default 2); without `at`, latest messages (default 6).' },
      after: { type: 'integer', minimum: 1, maximum: 50, description: 'Messages after `at` (default 2).' },
      full: { type: 'boolean', description: 'Only the message at `at` (else the latest), unshortened.' },
      maxChars: { type: 'integer', minimum: 500, maximum: MAX_READ_CHARS, description: `Output cap (default ${DEFAULT_READ_CHARS}).` },
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
      from = Math.max(0, at - integer(args.before, 2, 1, 50));
      to = Math.min(entries.length - 1, at + integer(args.after, 2, 1, 50));
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
  description: 'The user\'s other conversations that are working, open or active in the last 2 hours, each with provider, last activity, last request, a running turn\'s duration and current step, and any approval it waits for.',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      includeCurrent: { type: 'boolean', description: 'Include the conversation you are in.' },
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

const LIST_CAP = 12;
const QUERY_CAP = 15;
const READ_CAP = 40;

function optionalInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? Math.round(number) : Number.NaN;
}

function accountPhrase(session: HarnessSession, accounts: readonly { id: string; label?: string; plan?: { name?: string } }[]): string | undefined {
  if (!session.accountId) return undefined;
  const account = accounts.find((item) => item.id === session.accountId);
  const plan = account?.plan?.name?.trim();
  const label = account?.label?.trim();
  const extra = plan || (label && !label.includes('@') && label.length <= 24 ? label : '');
  const id = shortId(session.accountId);
  return extra ? `account ${id} (${extra}) now` : `account ${id} now`;
}

function topicTools(topic: PresentedTopic): string {
  return topic.tools.join(', ');
}

function fileLine(topic: PresentedTopic): string {
  const files = topic.files.map((file) => `${file.path} (+${file.additions} -${file.removals})`);
  if (topic.unnamedEdits) files.push(`${topic.unnamedEdits} unnamed edit${topic.unnamedEdits === 1 ? '' : 's'}`);
  if (files.length) return `files: ${files.join(', ')}`;
  return topic.logged ? 'files: none recorded for this span' : 'files: none kept (the turn log holds the last 20 turns)';
}

function whenLine(topic: PresentedTopic, now: number): string {
  if (!topic.at) return 'time unknown';
  const at = Date.parse(topic.at);
  return Number.isNaN(at) ? 'time unknown' : ago(at, now);
}

function listRow(topic: PresentedTopic, now: number): string {
  return `${rangeLabel(topic)} · ${topic.status} · ${topic.origin} · ${whenLine(topic, now)} · ${oneLine(topic.requests[0]?.text ?? '')}`;
}

function detailText(topic: PresentedTopic, which: string, now: number): string {
  const lines = [`${which} · ${rangeLabel(topic)} · ${topic.status} · ${topic.origin} · ${whenLine(topic, now)}`];
  lines.push('requests:');
  for (const request of topic.requests) lines.push(`  ${request.index !== undefined ? `#${request.index} ` : ''}${oneLine(request.text, 160)}`);
  if (topic.decisions.length) {
    lines.push('decisions:');
    for (const decision of topic.decisions) lines.push(`  ${decision.index !== undefined ? `#${decision.index} ` : ''}"${oneLine(decision.text, 180)}"`);
  }
  if (topic.finished) lines.push(`finished: ${topic.finished}`);
  if (topic.unfinished) lines.push(`unfinished: ${topic.unfinished}`);
  const tools = topicTools(topic);
  if (tools) lines.push(`tools: ${tools}`);
  lines.push(fileLine(topic));
  if (topic.from !== undefined && topic.to !== undefined) lines.push(`read these messages: hindsight(from=${topic.from}, to=${topic.to})`);
  return lines.join('\n');
}

async function hindsightMessages(session: HarnessSession, group: ConversationGroup): Promise<{ messages: HindsightMessage[]; pending?: HarnessSession['pendingTurn'] }> {
  const view = await conversationView(group);
  const transcript = await readSessionTranscript(session.id);
  const raw = transcript.messages ?? [];
  const positions = view.positions.get(session.id);
  return {
    // The running turn lives on the transcript. The index row does not carry it.
    pending: transcript.pendingTurn ?? session.pendingTurn,
    messages: raw.map((message, local) => ({
      index: positions?.[local] ?? local,
      role: message.role,
      content: message.content ?? '',
      ...(message.origin ? { origin: { ...(message.origin.harness ? { harness: message.origin.harness } : {}), provider: message.origin.provider, model: message.origin.model } } : {}),
      ...(message.role === 'assistant' ? { tools: readTurnActivities(message.activities, (message.content ?? '').length).map((activity) => activity.event.label).filter(Boolean) } : {}),
    })),
  };
}

const hindsightTool: ConversationTool = {
  name: 'hindsight',
  description: 'This conversation only, cut into topics from the stored transcript. No arguments opens the topic in progress and lists earlier ones, newest first, with message numbers. back=1 opens the topic before the one in progress: its requests, what finished, what was left unfinished, the user\'s direction-changing lines quoted with their message numbers, tool calls, and the files the turn log still has for those requests. before ("12h", "2d", or a date) keeps topics from before then. query finds a phrase in this chat. from and to, or at, read the stored messages and their tool calls; a span that was compacted is the summary that replaced it. One of back, query, or from/to. A record of this chat, not of the current tree.',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      back: { type: 'integer', minimum: 0, description: 'Open the topic this many before the one in progress: 1 is the one just before it. 0 or left out is the list.' },
      before: { type: 'string', description: 'Only topics from before this: "12h", "2d", "1w" or a date. Narrows the list and back.' },
      query: { type: 'string', description: 'A phrase to find in this chat, with message numbers.' },
      at: { type: 'string', description: 'One stored message: a message number or an anchor ("6e647d75:14").' },
      from: { type: 'integer', minimum: 0, description: 'First stored message to read, inclusive.' },
      to: { type: 'integer', minimum: 0, description: 'Last stored message to read, inclusive.' },
      full: { type: 'boolean', description: 'With at, from, or to: the one message (or the first of the range) unshortened, tool output included.' },
      maxChars: { type: 'integer', minimum: 500, maximum: MAX_READ_CHARS, description: `Output cap when reading messages (default ${DEFAULT_READ_CHARS}).` },
    },
  },
  async run(args, context) {
    if (!context.currentSessionId) return { text: 'hindsight is this conversation, and this call has none.', isError: true };
    const back = optionalInteger(args.back);
    if (Number.isNaN(back) || (back !== undefined && back < 0)) return { text: 'hindsight back is a message count of 0 or more. 1 is the topic before the one in progress.', isError: true };
    const spanFrom = optionalInteger(args.from);
    const spanTo = optionalInteger(args.to);
    if (Number.isNaN(spanFrom) || Number.isNaN(spanTo) || (spanFrom !== undefined && spanFrom < 0) || (spanTo !== undefined && spanTo < 0)) return { text: 'hindsight from and to are message numbers.', isError: true };
    // 0 is a real message number, and also what a caller that fills every field
    // sends for an end it has nothing to say about. It counts where it can: a
    // start before a real end. An end of 0 is the default (a single message 0 is
    // `at: "0"`), and so is a start of 0 with no end.
    const toArg = spanTo === 0 ? undefined : spanTo;
    const fromArg = spanFrom === 0 && toArg === undefined ? undefined : spanFrom;
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const reading = args.at !== undefined && args.at !== null && args.at !== '' || fromArg !== undefined || toArg !== undefined;
    // back=0 is the list, and a caller that fills every field always sends it.
    const modes = [back !== undefined && back > 0, Boolean(query), reading].filter(Boolean).length;
    if (modes > 1) return { text: 'hindsight takes one of back, query, or from/to. before narrows back and the list.', isError: true };
    const now = context.now ?? Date.now();
    const beforeMs = parseSince(typeof args.before === 'string' ? args.before : undefined, now);
    if (typeof args.before === 'string' && args.before.trim() && beforeMs === undefined) return { text: `Cannot read before="${args.before}". Use "2d", "12h", "1w" or a date.`, isError: true };
    if (query && beforeMs !== undefined) return { text: 'before narrows topics. A phrase search is query on its own.', isError: true };
    const found = findConversation(await conversationGroups(), context.currentSessionId);
    if (!found) return { text: 'This conversation has no saved chat to look back through.', isError: true };
    const wanted = context.currentSessionId.toLowerCase();
    const session = found.group.branches.find((item) => item.id.toLowerCase() === wanted) ?? found.branch ?? found.group.newest;
    const loaded = await hindsightMessages(session, found.group);
    const messages = loaded.messages;
    const index = await loadIndex();
    const records = await readTurnChanges(stateDirectory(), session.id);
    const pendingTurn = loaded.pending;
    const pending = pendingTurn?.prompt?.trim()
      ? {
          prompt: pendingTurn.prompt,
          startedAt: pendingTurn.startedAt,
          tools: readTurnActivities(pendingTurn.activities, (pendingTurn.response ?? '').length).map((activity) => activity.event.label).filter(Boolean),
          steers: (pendingTurn.steers ?? []).map((steer) => steer.text),
        }
      : undefined;
    const originFallback = runsOn({ provider: session.provider ?? null, model: session.model ?? null, ...(session.nativeHarness ? { harness: session.nativeHarness } : {}) });
    const presented = presentTopics(messages, { ...(pending ? { pending } : {}), records, originFallback });
    const account = accountPhrase(session, index?.accounts ?? []);
    const header = [
      `${maskSecrets(conversationTitle(session))} — id ${shortId(found.group.id)}`,
      originFallback,
      ...(account ? [account] : []),
    ].join(' · ');
    const note = 'This is the stored chat, not the current tree.';
    if (query) {
      const needle = query.toLowerCase().replace(/\s+/g, ' ');
      const pattern = new RegExp(needle.split(' ').map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'));
      const view = await conversationView(found.group);
      const hits: string[] = [];
      for (const message of messages) {
        const doc = view.entries[message.index]?.message;
        const haystack = doc?.lower ?? message.content.toLowerCase();
        const at = haystack.search(pattern);
        if (at < 0) continue;
        const line = doc ? snippetLine(message.index, doc, at) : `#${message.index} ${message.role}: ${oneLine(message.content, 160)}`;
        hits.push(line);
        if (hits.length >= QUERY_CAP) break;
      }
      if (!hits.length) return { text: maskSecrets(`${header}\n"${oneLine(query, 80)}" does not come up in this chat.\n${note}`) };
      const more = messages.filter((message) => (view.entries[message.index]?.message.lower ?? message.content.toLowerCase()).search(pattern) >= 0).length;
      const extra = more > hits.length ? `\n(${more - hits.length} more)` : '';
      return { text: maskSecrets(`${header}\n"${oneLine(query, 80)}" in this chat:\n${hits.map((hit) => `  ${hit}`).join('\n')}${extra}\n${note}`) };
    }
    if (reading) {
      const anchor = args.at === undefined || args.at === null || args.at === '' ? undefined : parseAnchor(args.at);
      if (args.at !== undefined && args.at !== null && args.at !== '' && !anchor) return { text: `Cannot read at="${String(args.at)}". Use a message number or an anchor like "6e647d75:14".`, isError: true };
      const view = await conversationView(found.group);
      const numbers = new Set(messages.map((message) => message.index));
      let at = anchor ? resolveAnchor(anchor, found.group, view, await conversationGroups()) : undefined;
      if (anchor && (at === undefined || !numbers.has(at))) return { text: `${header}\nThere is no message ${String(args.at)} in this chat.`, isError: true };
      let from = fromArg ?? at ?? toArg!;
      let to = toArg ?? at ?? fromArg!;
      if (from > to) [from, to] = [to, from];
      if (!numbers.has(from) || !numbers.has(to)) return { text: `${header}\nMessages ${from}–${to} are not both in this chat. A topic's from and to are the numbers hindsight listed.`, isError: true };
      const maxChars = integer(args.maxChars, DEFAULT_READ_CHARS, 500, MAX_READ_CHARS);
      const picked = messages.filter((message) => message.index >= from && message.index <= to);
      if (!picked.length) return { text: `${header}\nMessages ${from}–${to} are not in this chat.`, isError: true };
      if (args.full === true) {
        const index = at ?? picked[0]!.index;
        const entry = view.entries[index]?.message;
        if (!entry) return { text: `${header}\nThere is no message ${index} in this chat.`, isError: true };
        return { text: [header, 'Stored transcript. A compacted span is the summary that replaced it.', renderFullMessage(index, entry, Math.max(200, maxChars - header.length - 80)), note].join('\n') };
      }
      const shown = picked.slice(0, READ_CAP);
      const share = Math.max(200, Math.floor((maxChars - header.length - 200) / shown.length));
      const blocks = shown.map((message) => {
        const entry = view.entries[message.index]?.message;
        return entry ? renderMessage(message.index, entry, share).text : `[#${message.index} ${message.role}] ${oneLine(message.content, share)}`;
      });
      const tail = shown.length < picked.length ? [`(stopped at #${shown.at(-1)!.index}; the range runs to #${picked.at(-1)!.index})`] : [];
      const first = shown[0]!.index;
      const last = shown.at(-1)!.index;
      return { text: [header, `Stored messages ${first}–${last}. A compacted span is the summary that replaced it.`, ...blocks, ...tail, note].join('\n') };
    }
    const earlier = topicsBefore(presented.earlier, beforeMs).reverse();
    const dropped = beforeMs !== undefined ? presented.earlier.length - earlier.length : 0;
    if (back !== undefined && back > 0) {
      const chosen = earlier[back - 1];
      if (!chosen) {
        const howMany = earlier.length;
        return { text: `${header}\nThis chat has ${howMany} earlier topic${howMany === 1 ? '' : 's'}${dropped ? ` from before ${args.before}` : ''}. back=${back} is before the start.`, isError: true };
      }
      const which = `Topic back ${back} of ${earlier.length}`;
      return { text: maskSecrets(`${header}\n${detailText(chosen, which, now)}\n${note}`) };
    }
    const shown = earlier.slice(0, LIST_CAP);
    const lines = [header];
    if (presented.current) lines.push(detailText(presented.current, presented.current.status === 'in progress' ? 'Topic in progress' : 'Latest topic', now));
    else lines.push('Latest: none.');
    if (!shown.length) lines.push(dropped ? `No earlier topic is from before ${args.before}.` : 'No earlier topic.');
    else {
      lines.push(`Earlier, newest first${dropped ? `, from before ${args.before}` : ''} (hindsight(back=1) opens the one just before this):`);
      shown.forEach((topic, index) => lines.push(`${index + 1}. ${listRow(topic, now)}`));
      if (earlier.length > shown.length) lines.push(`(${earlier.length - shown.length} more; hindsight(back=${shown.length + 1}) reaches the next)`);
    }
    lines.push(note);
    return { text: maskSecrets(lines.join('\n')) };
  },
};

function snippetLine(index: number, message: { role: string; text: string; lower: string; contentLength: number }, at: number): string {
  const source = message.text;
  const start = Math.max(0, at - 40);
  const excerpt = source.slice(start, at + 80).replace(/\s+/g, ' ').trim();
  const where = at >= message.contentLength ? `${message.role} (tool call)` : message.role;
  return `#${index} ${where}: ${start > 0 ? '…' : ''}${excerpt}`;
}

export const CONVERSATION_TOOLS: readonly ConversationTool[] = [searchTool, readTool, activeTool, hindsightTool];

export function conversationTool(name: string): ConversationTool | undefined {
  return CONVERSATION_TOOLS.find((tool) => tool.name === name);
}
