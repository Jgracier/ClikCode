/** Conversation search: which conversations mention something, how often,
 * and exactly where.
 *
 * Ranking, in order of what decides:
 *   1. Its title is the query (case-insensitive), then a title holding every
 *      word: a conversation named for something outranks any that mention it.
 *   2. A conversation with the exact phrase (case-insensitive) is above one
 *      that only has every word somewhere in a message.
 *   3. Mentions, weighted by how recent the conversation is: the same count
 *      in this week's chat outranks last month's.
 *
 * A conversation's mentions are its exact occurrences of the phrase when it
 * has any; only when it has none, each message holding every word. So the
 * count, the snippets and the /search walk are all of one kind. A
 * conversation's branches share history; it is searched as one merged
 * numbering (corpus.ts conversationView), so a shared message counts once. */

import { conversationGroups, conversationTitle, type ConversationGroup } from './conversations.js';
import { conversationView, type MessageDoc } from './corpus.js';

export interface Mention {
  /** The chat (branch) the message is stored in, and where in it: what the
   * terminal opens. */
  sessionId: string;
  messageIndex: number;
  /** Where it is in the conversation's merged numbering: what agents see. */
  position: number;
  /** Into the message's searchable text (content, then its tool calls). */
  offset: number;
  length: number;
  exact: boolean;
}

export interface ConversationHit {
  conversationId: string;
  /** The newest branch: what opening the conversation opens. */
  sessionId: string;
  title: string;
  provider: string | null;
  model: string | null;
  harness?: string;
  updatedAt: string;
  updatedAtMs: number;
  /** In the conversation's merged order. All exact when exactCount > 0. */
  mentions: Mention[];
  exactCount: number;
  /** The title is the query, or holds every word of it. */
  titleMatch?: 'exact' | 'words';
  score: number;
}

export interface ParsedQuery {
  text: string;
  words: string[];
  /** The phrase, as a pattern over lower-cased text: the words in order with
   * any whitespace, hyphens or underscores between them ("self-improvement"
   * is the phrase "self improvement"). */
  phrase: RegExp;
}

export interface SearchOptions {
  /** Only conversations active at or after this time (ms). */
  sinceMs?: number;
  /** Only this conversation (its id). */
  conversationId?: string;
  /** Left out entirely: the conversation an agent is asking from. */
  excludeConversationId?: string;
  excludeSessionId?: string;
  now?: number;
}

export interface SearchResult {
  query: ParsedQuery;
  hits: ConversationHit[];
  /** Conversations looked through. */
  searched: number;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function parseQuery(text: string): ParsedQuery | undefined {
  const cleaned = text.trim().replace(/^["']|["']$/g, '').trim();
  const words = [...new Set(cleaned.toLowerCase().split(/\s+/).filter(Boolean))];
  if (!words.length) return undefined;
  const ordered = cleaned.toLowerCase().split(/\s+/).filter(Boolean);
  return { text: cleaned, words, phrase: new RegExp(ordered.map(escapeRegExp).join('[\\s_-]+'), 'g') };
}

/** `7d`, `12h`, `30m`, `2w`, or a date. Undefined when it is neither. */
export function parseSince(value: string | undefined, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  const relative = /^(\d+(?:\.\d+)?)\s*(m|min|h|hr|d|day|days|w|wk|weeks?)$/i.exec(value.trim());
  if (relative) {
    const unit = relative[2]!.toLowerCase()[0];
    const ms = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : unit === 'd' ? 86_400_000 : 7 * 86_400_000;
    return now - Number(relative[1]) * ms;
  }
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : at;
}

/** Up to 2.5x for a conversation from today, halving weekly toward 1x. */
export function recencyBoost(updatedAtMs: number, now: number): number {
  if (!Number.isFinite(updatedAtMs)) return 1;
  const days = Math.max(0, now - updatedAtMs) / 86_400_000;
  return 1 + 1.5 * 0.5 ** (days / 7);
}

/** Where one message mentions the query. Exact occurrences when it has
 * any; otherwise one mention at the first word, when it holds them all. */
export function messageMentions(message: MessageDoc, query: ParsedQuery): Array<{ offset: number; length: number; exact: boolean }> {
  const found: Array<{ offset: number; length: number; exact: boolean }> = [];
  const phrase = query.phrase;
  phrase.lastIndex = 0;
  for (let match = phrase.exec(message.lower); match; match = phrase.exec(message.lower)) {
    found.push({ offset: match.index, length: match[0].length, exact: true });
    if (match[0].length === 0) phrase.lastIndex += 1;
  }
  if (found.length || query.words.length < 2) return found;
  if (!query.words.every((word) => message.lower.includes(word))) return found;
  const first = query.words[0]!;
  return [{ offset: message.lower.indexOf(first), length: first.length, exact: false }];
}

/** How a title matches: it is the query, or it holds every word. */
export function titleMatch(title: string, query: ParsedQuery): ConversationHit['titleMatch'] {
  const lower = title.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!lower) return undefined;
  if (new RegExp(`^${query.phrase.source}$`).test(lower)) return 'exact';
  return query.words.every((word) => lower.includes(word)) ? 'words' : undefined;
}

const TITLE_TIER = { exact: 3_000_000, words: 2_000_000 } as const;

async function conversationHit(group: ConversationGroup, query: ParsedQuery, now: number): Promise<ConversationHit | undefined> {
  const view = await conversationView(group);
  let mentions: Mention[] = [];
  for (const [position, entry] of view.entries.entries()) {
    for (const mention of messageMentions(entry.message, query)) mentions.push({ sessionId: entry.sessionId, messageIndex: entry.index, position, ...mention });
  }
  const exactCount = mentions.filter((mention) => mention.exact).length;
  if (exactCount) mentions = mentions.filter((mention) => mention.exact);
  const newest = group.newest;
  const named = titleMatch(conversationTitle(newest, Number.POSITIVE_INFINITY), query);
  if (!mentions.length && !named) return undefined;
  // Title, then exact (whole tiers), then weighted mentions.
  const score = (named ? TITLE_TIER[named] : 0) + (exactCount ? 1_000_000 : 0) + (exactCount ? exactCount * 3 : mentions.length) * recencyBoost(group.updatedAtMs, now);
  return {
    conversationId: group.id, sessionId: newest.id, title: conversationTitle(newest),
    provider: newest.provider ?? null, model: newest.model ?? null,
    ...(newest.nativeHarness ? { harness: newest.nativeHarness } : {}),
    updatedAt: newest.updatedAt, updatedAtMs: group.updatedAtMs, mentions, exactCount, ...(named ? { titleMatch: named } : {}), score,
  };
}

export async function searchConversations(text: string, options: SearchOptions = {}): Promise<SearchResult | undefined> {
  const query = parseQuery(text);
  if (!query) return undefined;
  const now = options.now ?? Date.now();
  const groups = (await conversationGroups()).filter((group) => (options.conversationId === undefined || group.id === options.conversationId)
    && group.id !== options.excludeConversationId
    && !group.branches.some((branch) => branch.id === options.excludeSessionId)
    && (options.sinceMs === undefined || group.updatedAtMs >= options.sinceMs));
  const hits: ConversationHit[] = [];
  // In parallel: each transcript is its own file, and on a warm cache this
  // is a stat per file.
  const found = await Promise.all(groups.map((group) => conversationHit(group, query, now)));
  for (const hit of found) if (hit) hits.push(hit);
  hits.sort((left, right) => right.score - left.score || right.updatedAtMs - left.updatedAtMs);
  return { query, hits, searched: groups.length };
}
