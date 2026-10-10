/** `/hindsight`: this conversation cut into topics, as the agent's hindsight
 * tool cuts it (search/hindsight.ts), for the user. Numbered by the user's
 * prompts, the numbers /fork @N and /redo @N take -- not the merged message
 * numbers the agent tool reads by. */
import type { TranscriptMessage } from '../../session/model.js';
import type { TurnChangeRecord } from '../../session/turn-changes.js';
import { presentTopics, oneLine, type HindsightMessage, type PresentedTopic } from '../../search/hindsight.js';
import { ago } from '../../search/format.js';
import { INTERRUPTED_TURN_REQUEST } from '../../turn/failover-prompt.js';

/** The transcript as hindsight reads it: each user prompt numbered as
 * userMessageIndexes counts them, an answer under the prompt it answers. */
export function promptNumberedMessages(messages: readonly TranscriptMessage[]): HindsightMessage[] {
  let prompt = 0;
  return messages.flatMap((message) => {
    if (message.role === 'user' && message.content === INTERRUPTED_TURN_REQUEST) return [];
    if (message.role === 'user') prompt += 1;
    const origin = message.origin;
    return [{
      index: prompt, role: message.role, content: message.content ?? '',
      ...(origin ? { origin: { ...(origin.harness ? { harness: origin.harness } : {}), provider: origin.provider, model: origin.model } } : {}),
    }];
  });
}

function promptRange(topic: PresentedTopic): string {
  if (topic.from === undefined || topic.to === undefined) return '';
  return topic.from === topic.to ? `${topic.from}` : `${topic.from}–${topic.to}`;
}

function topicRows(topic: PresentedTopic, now: number): string[] {
  const at = topic.at ? Date.parse(topic.at) : Number.NaN;
  const head = [topic.status, ...(Number.isNaN(at) ? [] : [ago(at, now)]), ...(topic.origin ? [topic.origin] : [])].join(' · ');
  const more = topic.requests.length > 1 ? `  (+${topic.requests.length - 1} more)` : '';
  const files = topic.files.map((file) => `${file.path} +${file.additions} -${file.removals}`);
  if (topic.unnamedEdits) files.push(`${topic.unnamedEdits} unnamed edit${topic.unnamedEdits === 1 ? '' : 's'}`);
  return [
    `  ${promptRange(topic).padStart(5)}  ${head}`,
    `         ${oneLine(topic.requests[0]?.text ?? '', 80)}${more}`,
    ...(files.length ? [`         files: ${files.slice(0, 4).join(', ')}${files.length > 4 ? ` +${files.length - 4} more` : ''}`] : []),
  ];
}

/** The panel: topics newest first, then how to act on a number. */
export function hindsightPanelText(
  messages: readonly TranscriptMessage[], records: readonly TurnChangeRecord[], options: { originFallback: string; now?: number },
): string {
  const presented = presentTopics(promptNumberedMessages(messages), { records, originFallback: options.originFallback });
  const topics = [...presented.earlier, ...(presented.current ? [presented.current] : [])].reverse();
  if (!topics.length) return 'Hindsight\nNo prompts in this conversation yet.';
  const now = options.now ?? Date.now();
  return [
    `Hindsight · ${topics.length} topic${topics.length === 1 ? '' : 's'}, newest first`,
    ...topics.flatMap((topic) => topicRows(topic, now)),
    '',
    'Numbers are your prompts: /fork @N branches through prompt N, /redo @N goes back to before it.',
  ].join('\n');
}
