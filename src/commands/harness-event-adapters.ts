/** Provider event envelopes terminate here. The orchestrator and terminal UI
 * consume only normalized response updates, never vendor JSON shapes. */
import type { AiLocalHarnessDefinition } from './types.js';

export interface NativeResponseUpdate { text: string; mode: 'append' | 'replace' }
type Json = Record<string, unknown>;
type ResponseParser = (value: Json) => NativeResponseUpdate | undefined;

const object = (value: unknown): Json | undefined => value && typeof value === 'object' ? value as Json : undefined;
const contentText = (value: unknown): string => Array.isArray(value) ? value.flatMap((part) => {
  const record = object(part);
  return record?.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
}).join('') : '';

const parsers: Readonly<Record<string, ResponseParser>> = {
  codex: (value) => {
    if (value.type !== 'item.completed') return undefined;
    const item = object(value.item);
    return item?.type === 'agent_message' && typeof item.text === 'string' && item.text
      ? { text: `${item.text}\n\n`, mode: 'append' } : undefined;
  },
  antigravity: (value) => {
    const step = value.event === 'step_update' ? object(value.step_update) : undefined;
    return step?.step_type === 'agent_response' && typeof step.text_delta === 'string' && step.text_delta
      ? { text: step.text_delta, mode: 'append' } : undefined;
  },
  claude: (value) => {
    const event = value.type === 'stream_event' ? object(value.event) : undefined;
    const delta = object(event?.delta);
    return event?.type === 'content_block_delta' && typeof delta?.text === 'string' && delta.text
      ? { text: delta.text, mode: 'append' } : undefined;
  },
  qwen: (value) => parsers.claude!(value),
  gemini: (value) => value.type === 'message' && value.role === 'assistant' && typeof value.content === 'string' && value.content
    ? { text: value.content, mode: value.delta === false ? 'replace' : 'append' } : undefined,
  cursor: (value) => {
    const message = value.type === 'assistant' ? object(value.message) : undefined;
    const text = contentText(message?.content);
    return text ? { text, mode: 'append' } : undefined;
  },
  cline: (value) => value.type === 'say' && typeof value.text === 'string' && value.text
    ? { text: value.text, mode: 'replace' } : undefined,
  pi: (value) => {
    const event = value.type === 'message_update' ? object(value.assistantMessageEvent) : undefined;
    return event?.type === 'text_delta' && typeof event.delta === 'string' && event.delta
      ? { text: event.delta, mode: 'append' } : undefined;
  },
  goose: (value) => {
    const message = value.type === 'message' ? object(value.message) : undefined;
    const text = message?.role === 'assistant' ? contentText(message.content) : '';
    return text ? { text, mode: 'append' } : undefined;
  },
  opencode: (value) => {
    const part = value.type === 'text' ? object(value.part) : undefined;
    const text = typeof part?.text === 'string' ? part.text : typeof value.text === 'string' ? value.text : '';
    return text ? { text, mode: 'append' } : undefined;
  },
  kilo: (value) => parsers.opencode!(value),
};

export function nativeResponseUpdate(harness: AiLocalHarnessDefinition, lineText: string): NativeResponseUpdate | undefined {
  const parser = parsers[harness.command];
  if (!parser) return undefined;
  try { return parser(JSON.parse(lineText) as Json); } catch { return undefined; }
}
