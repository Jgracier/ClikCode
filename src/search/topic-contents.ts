/** The conversation's contents after a compaction: one line per topic (hindsight.ts topicSpans),
 * with its message numbers, so the model working from a summary knows what there was and where
 * to read it (hindsight from/to). Built by ClikCode from the transcript, never by a model. */
import type { TranscriptMessage } from '../session/model.js';
import { quiet } from '../runtime/lifecycle-log.js';
import { conversationGroups, findConversation } from './conversations.js';
import { conversationView } from './corpus.js';
import { oneLine, presentTopics, rangeLabel, type HindsightMessage } from './hindsight.js';

/** About 1k tokens. */
export const TOPIC_CONTENTS_MAX_CHARS = 4000;

/** The contents of `messages` (numbered as the hindsight tool numbers them), newest topics kept
 * when they do not all fit. Undefined when there is no topic. */
export function topicContentsText(messages: readonly HindsightMessage[], hasHindsight: boolean, maxChars = TOPIC_CONTENTS_MAX_CHARS): string | undefined {
  const { current, earlier } = presentTopics(messages, { originFallback: '' });
  const topics = [...earlier, ...current ? [current] : []].filter((topic) => topic.requests.length);
  if (!topics.length) return undefined;
  const lines = topics.map((topic) => {
    const first = topic.requests[0]!.text;
    const then = topic.decisions.filter((decision) => decision.text !== first).at(-1);
    return `${rangeLabel(topic)}: ${oneLine(first, 110)}${then ? ` | then: ${oneLine(then.text, 70)}` : ''}`;
  });
  const header = `This conversation's topics, by message number${hasHindsight ? ' (hindsight from/to reads any of them whole)' : ''}:`;
  const nudge = hasHindsight && process.env.CLIKCODE_EVAL_SEARCH_NUDGE !== '0' ? [SEARCH_NUDGE] : [];
  let used = header.length + lines.reduce((sum, line) => sum + line.length + 1, 0) + nudge.reduce((sum, line) => sum + line.length + 1, 0);
  let dropped = 0;
  /** Room held back for the line that says how many were left out. */
  const omittedRoom = (): number => dropped ? 40 : 0;
  while (used + omittedRoom() > maxChars && dropped < lines.length - 1) { used -= lines[dropped]!.length + 1; dropped += 1; }
  return [header, ...dropped ? [`(${dropped} earlier topic${dropped === 1 ? '' : 's'} not listed)`] : [], ...lines.slice(dropped), ...nudge].join('\n');
}

/** With hindsight (the compaction eval's floor run; CLIKCODE_EVAL_SEARCH_NUDGE=0 leaves it out): the summary is not the conversation; look before saying it is not there. */
const SEARCH_NUDGE = 'Your summary leaves out most of what these messages said. When a question is about anything before your summary (a value, a name, a commit, why something was decided), search with hindsight query=<its words> or read the messages above with from/to before answering; never answer that it is not recorded, or from memory, without searching first.';

/** The compacted part's identifier list (CLIKCODE_EVAL_ID_LIST=0 leaves it out): about 1.5k tokens (CLIKCODE_EVAL_ID_MAX_CHARS sets it in the eval). */
export const IDENTIFIER_LIST_MAX_CHARS = 6000;

const IDENTIFIER_PATTERNS: Array<{ rank: number; pattern: RegExp }> = [
  { rank: 0, pattern: /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g },
  { rank: 1, pattern: /\b[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)*[_-]?\d[A-Za-z0-9_-]*\b|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g },
  { rank: 2, pattern: /(?:~|\.{0,2})?\/?[\w.-]+\/[\w./-]*\.[A-Za-z]{1,6}\b/g },
  { rank: 3, pattern: /https?:\/\/[^\s)`'"\]]+/g },
];

/** The identifiers of `messages` (commit hashes, names with digits, CONSTANT_NAMES, paths, URLs), each
 * once, with the words before it and its message number, rarest kinds first within `maxChars`, listed
 * in message order. What a summary drops first and a question names exactly. Undefined when none. */
export function identifierListText(messages: readonly HindsightMessage[], maxChars = Number(process.env.CLIKCODE_EVAL_ID_MAX_CHARS) || IDENTIFIER_LIST_MAX_CHARS): string | undefined {
  const contextChars = Number(process.env.CLIKCODE_EVAL_ID_CONTEXT) || 45;
  const byValue = new Map<string, { index: number; rank: number; order: number; count: number; line: string }>();
  for (const message of messages) {
    const text = message.content.replace(/\s+/g, ' ');
    for (const { rank, pattern } of IDENTIFIER_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const value = match[0];
        const key = value.toLowerCase();
        if (value.length < 5) continue;
        const prior = byValue.get(key);
        if (prior) { prior.count += 1; continue; }
        const at = match.index ?? 0;
        const before = text.slice(Math.max(0, at - contextChars), at).replace(/^\S*\s/, '').replace(/[`*]/g, '');
        byValue.set(key, { index: message.index, rank, order: byValue.size, count: 1, line: `#${message.index} ${before}${value}` });
      }
    }
  }
  if (!byValue.size) return undefined;
  const header = 'Identifiers in those messages, each after the words before it (message number):';
  const mode = process.env.CLIKCODE_EVAL_ID_ORDER ?? 'mentions';
  const all = [...byValue.values()];
  const ranked = mode === 'newest' ? all.sort((left, right) => left.rank - right.rank || right.order - left.order)
    : mode === 'spread' ? spread(all)
    : all.sort((left, right) => right.count - left.count || left.rank - right.rank || right.order - left.order);
  let used = header.length;
  const kept = [];
  for (const item of ranked) {
    if (used + item.line.length + 1 > maxChars) continue;
    used += item.line.length + 1;
    kept.push(item);
  }
  return [header, ...kept.sort((left, right) => left.order - right.order).map((item) => item.line)].join('\n');
}

/** `items` in an order that takes from every part of the conversation evenly (bit-reversed index). */
function spread<T>(items: T[]): T[] {
  const order: T[] = [];
  const taken = new Set<number>();
  for (let step = items.length; step >= 1; step = Math.floor(step / 2)) {
    for (let index = 0; index < items.length; index += step) if (!taken.has(index)) { taken.add(index); order.push(items[index]!); }
    if (step === 1) break;
  }
  return order;
}

/** The contents of a session's transcript, numbered in its conversation's merged view where it
 * has one. Never throws. */
export async function topicContents(session: { id: string; messages?: readonly TranscriptMessage[] }, hasHindsight: boolean, options: { through?: number } = {}): Promise<string | undefined> {
  const raw = session.messages ?? [];
  if (!raw.length) return undefined;
  const positions = await (async () => {
    const found = findConversation(await conversationGroups(), session.id);
    if (!found) return undefined;
    return (await conversationView(found.group)).positions.get(session.id);
  })().catch(quiet('search/topic-contents'));
  const messages: HindsightMessage[] = [];
  raw.forEach((message, local) => {
    if (message.role === 'user' || message.role === 'assistant') messages.push({ index: positions?.[local] ?? local, role: message.role, content: message.content ?? '' });
  });
  const contents = topicContentsText(messages, hasHindsight);
  if (process.env.CLIKCODE_EVAL_ID_LIST === '0') return contents;
  // The identifiers of the messages the context holds only as a summary (local index < through).
  const through = options.through ?? raw.length;
  const compacted: HindsightMessage[] = [];
  raw.forEach((message, local) => {
    if (local < through && (message.role === 'user' || message.role === 'assistant')) compacted.push({ index: positions?.[local] ?? local, role: message.role, content: message.content ?? '' });
  });
  const identifiers = identifierListText(compacted);
  return [contents, identifiers].filter(Boolean).join('\n\n') || undefined;
}
