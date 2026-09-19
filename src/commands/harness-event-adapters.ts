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

// No `codex` entry: codex always negotiates the app-server transport, so this
// path never sees it. Its item.completed/agent_message shape is covered by the
// generic parser below if that ever changes.
const parsers: Readonly<Record<string, ResponseParser>> = {
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

/** Envelope types that never carry the assistant's own words. Checked first so
 * tool input, user echoes, and diagnostics can never reach the live response. */
const NON_ASSISTANT_TYPE = /(?:^|[._-])(?:user|human|tool|function|system|error|usage|stat)(?:$|[._-])/i;
const ASSISTANT_TEXT_TYPE = /(?:^|[._-])(?:assistant|agent|message|text|say|delta|chunk)(?:$|[._-])/i;
const TERMINAL_RESULT_TYPE = /(?:^|[._-])(?:result|response|final|complete|completed)(?:$|[._-])/i;

const stringValue = (...candidates: unknown[]): string | undefined =>
  candidates.find((candidate): candidate is string => typeof candidate === 'string' && Boolean(candidate));

/** Shape-driven fallback for catalog harnesses with no vendor parser. Vendors
 * converge on a handful of streaming envelopes, so matching those shapes keeps
 * every json-lines harness live without a guessed entry per command — and a
 * shape nobody recognizes simply yields nothing, exactly like today.
 *
 * Streamed text is presentation only: the persisted answer is always
 * re-extracted from the complete stdout by nativeTurnResult, so a mismatch
 * here costs a blank live region, never a wrong transcript. */
const genericParser: ResponseParser = (value) => {
  const envelope = object(value.event) ?? value;
  const type = typeof envelope.type === 'string' ? envelope.type : '';
  if (NON_ASSISTANT_TYPE.test(type) || envelope.role === 'user') return undefined;
  const delta = object(envelope.delta);
  if (typeof delta?.text === 'string' && delta.text) return { text: delta.text, mode: 'append' };
  const item = object(envelope.item);
  if (item && ASSISTANT_TEXT_TYPE.test(String(item.type ?? '')) && typeof item.text === 'string' && item.text) {
    return { text: `${item.text}\n\n`, mode: 'append' };
  }
  const message = object(envelope.message);
  if (message && (message.role === undefined || message.role === 'assistant')) {
    const text = contentText(message.content) || stringValue(message.content, message.text);
    if (text) return { text, mode: 'append' };
  }
  if (ASSISTANT_TEXT_TYPE.test(type)) {
    const text = contentText(envelope.content) || stringValue(envelope.text, object(envelope.part)?.text, envelope.content);
    if (text) return { text, mode: 'append' };
  }
  if (TERMINAL_RESULT_TYPE.test(type)) {
    const text = stringValue(envelope.result, envelope.response);
    if (text?.trim()) return { text, mode: 'replace' };
  }
  return undefined;
};

export function nativeResponseUpdate(harness: AiLocalHarnessDefinition, lineText: string): NativeResponseUpdate | undefined {
  const parser = parsers[harness.command];
  // Plain-text harnesses print the answer itself and nativeTurnResult returns
  // that same stdout, so echoing each line live cannot diverge from what is
  // ultimately persisted. Without this they show nothing at all until the turn
  // ends, which on a long edit reads as a hung session.
  if (!parser && harness.turn?.output === 'text') return { text: `${lineText}\n`, mode: 'append' };
  try {
    return (parser ?? genericParser)(JSON.parse(lineText) as Json);
  } catch {
    // fail-open-ok: vendors interleave non-JSON banners and progress chatter on
    // stdout. A line that does not parse carries no response update, so absence
    // is the answer rather than a swallowed failure.
    return undefined;
  }
}
