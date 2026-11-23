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
  let used = header.length + lines.reduce((sum, line) => sum + line.length + 1, 0);
  let dropped = 0;
  /** Room held back for the line that says how many were left out. */
  const omittedRoom = (): number => dropped ? 40 : 0;
  while (used + omittedRoom() > maxChars && dropped < lines.length - 1) { used -= lines[dropped]!.length + 1; dropped += 1; }
  return [header, ...dropped ? [`(${dropped} earlier topic${dropped === 1 ? '' : 's'} not listed)`] : [], ...lines.slice(dropped)].join('\n');
}

/** The contents of a session's transcript, numbered in its conversation's merged view where it
 * has one. Never throws. */
export async function topicContents(session: { id: string; messages?: readonly TranscriptMessage[] }, hasHindsight: boolean): Promise<string | undefined> {
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
  return topicContentsText(messages, hasHindsight);
}
