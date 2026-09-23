/** Provider event envelopes terminate here. The orchestrator and terminal UI
 * consume only normalized response updates, never vendor JSON shapes. */
import type { AiLocalHarnessDefinition } from '../definition.js';
import { parseNativeActivityEventsFromValue, type NativeActivityEvent } from '../protocol/activity-events.js';
import { nativeActivityPhaseFromValue } from '../protocol/activity-line.js';
import { nativeSessionIdsFromValues } from '../protocol/session-ids.js';
import { nativeUsageFromValue, type NativeTurnUsage } from '../protocol/turn-usage.js';

interface NativeResponseUpdate { text: string; mode: 'append' | 'replace' }
type Json = Record<string, unknown>;
type ResponseParser = (value: Json, harness: AiLocalHarnessDefinition) => NativeResponseUpdate | undefined;

/** What the live region already holds for one running turn. Two vendor
 * behaviours cannot be handled one line at a time: Claude's text blocks arrive
 * with no separator across a tool call, and Cursor re-sends each streamed
 * segment as one full message. Keyed by harness + the stream's own session id,
 * reset by the stream's init record and dropped at its result record. */
interface StreamState {
  /** Any assistant text has been emitted this turn. */
  hasText: boolean;
  /** Real text deltas were seen, so whole-message records are repeats. */
  sawDeltas: boolean;
  /** Cursor: deltas accumulated since the last full-segment flush. */
  segment: string;
  segmentChunks: number;
  /** A tool call happened since the last text; the next text starts a paragraph. */
  needsSeparator: boolean;
}
const streamStates = new Map<string, StreamState>();
const MAX_STREAM_STATES = 32;

function streamState(harness: AiLocalHarnessDefinition, value: Json): StreamState {
  const key = `${harness.command}:${typeof value.session_id === 'string' ? value.session_id : ''}`;
  let state = streamStates.get(key);
  if (value.type === 'system' && value.subtype === 'init') state = undefined;
  if (!state) {
    state = { hasText: false, sawDeltas: false, segment: '', segmentChunks: 0, needsSeparator: false };
    streamStates.delete(key);
    streamStates.set(key, state);
    if (streamStates.size > MAX_STREAM_STATES) streamStates.delete(streamStates.keys().next().value as string);
  }
  if (value.type === 'result') streamStates.delete(key);
  return state;
}

/** Forget all per-turn streaming state (tests; or before reusing a session id
 * for a new turn on a harness that emits no init record). */
function resetHarnessStreamState(): void {
  streamStates.clear();
}

/** Text as it should be appended given what came before it. */
function appendText(state: StreamState, text: string): NativeResponseUpdate {
  const separator = state.needsSeparator && state.hasText ? '\n\n' : '';
  state.needsSeparator = false;
  state.hasText = true;
  return { text: `${separator}${text}`, mode: 'append' };
}

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
  claude: (value, harness) => {
    // A subagent's words are its own, not the reply being written.
    if (typeof value.parent_tool_use_id === 'string' && value.parent_tool_use_id) return undefined;
    const state = streamState(harness, value);
    if (value.type === 'stream_event') {
      const event = object(value.event);
      const block = object(event?.content_block);
      // A new text block after earlier text is a new paragraph: the blocks are
      // split by a tool call, and joined bare they read "Let me check.Found it."
      if (event?.type === 'content_block_start' && block?.type === 'text') {
        if (state.hasText) state.needsSeparator = true;
        return undefined;
      }
      const delta = object(event?.delta);
      if (event?.type !== 'content_block_delta' || typeof delta?.text !== 'string' || !delta.text) return undefined;
      state.sawDeltas = true;
      return appendText(state, delta.text);
    }
    // Without --include-partial-messages (or on a build that ignores it) the
    // completed message is the only carrier of the text.
    if (value.type === 'assistant' && !state.sawDeltas) {
      const text = contentText(object(value.message)?.content);
      if (!text) return undefined;
      if (state.hasText) state.needsSeparator = true;
      return appendText(state, text);
    }
    return undefined;
  },
  // Read from cursor-agent's own emitter: with --stream-partial-output every
  // text delta is an `assistant` record (always with timestamp_ms), and the
  // deltas accumulated so far are then RE-SENT as one full `assistant` record
  // -- before each tool call (timestamp_ms + model_call_id) and once more at
  // the end (no timestamp_ms). Appending those repeats printed every segment
  // twice. Without partial output only the full records exist.
  cursor: (value, harness) => {
    const state = streamState(harness, value);
    if (value.type === 'tool_call') {
      if (state.hasText) state.needsSeparator = true;
      return undefined;
    }
    const message = value.type === 'assistant' ? object(value.message) : undefined;
    const text = contentText(message?.content);
    if (!text) return undefined;
    const isDelta = typeof value.timestamp_ms === 'number' && typeof value.model_call_id !== 'string'
      && !(state.segmentChunks > 0 && text === state.segment && (state.segmentChunks > 1 || text.length > 24));
    if (isDelta) {
      state.segment += text;
      state.segmentChunks += 1;
      return appendText(state, text);
    }
    // A full-segment flush: emit only what the deltas have not already shown.
    const shown = state.segment;
    state.segment = '';
    state.segmentChunks = 0;
    if (!shown) return appendText(state, text);
    if (text === shown) return undefined;
    return appendText(state, text.startsWith(shown) ? text.slice(shown.length) : text);
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
const genericParser: ResponseParser = (value, harness) => {
  const envelope = object(value.event) ?? value;
  const type = typeof envelope.type === 'string' ? envelope.type : '';
  if (NON_ASSISTANT_TYPE.test(type) || envelope.role === 'user') return undefined;
  const state = streamState(harness, value);
  const shown = (update: NativeResponseUpdate): NativeResponseUpdate => {
    if (update.text.trim()) state.hasText = true;
    return update;
  };
  const delta = object(envelope.delta);
  if (typeof delta?.text === 'string' && delta.text) return shown({ text: delta.text, mode: 'append' });
  const item = object(envelope.item);
  if (item && ASSISTANT_TEXT_TYPE.test(String(item.type ?? '')) && typeof item.text === 'string' && item.text) {
    return shown({ text: `${item.text}\n\n`, mode: 'append' });
  }
  const message = object(envelope.message);
  if (message && (message.role === undefined || message.role === 'assistant')) {
    const text = contentText(message.content) || stringValue(message.content, message.text);
    if (text) return shown({ text, mode: 'append' });
  }
  if (ASSISTANT_TEXT_TYPE.test(type)) {
    const text = contentText(envelope.content) || stringValue(envelope.text, object(envelope.part)?.text, envelope.content);
    if (text) return shown({ text, mode: 'append' });
  }
  if (TERMINAL_RESULT_TYPE.test(type)) {
    // The final report is the answer only when nothing else carried it. After
    // text has streamed it is at best a repeat and often just the last part
    // -- and as a `replace` it wiped the streamed answer off the screen at the
    // very end of the turn. See durableAnswer() for the saved copy.
    const text = stringValue(envelope.result, envelope.response);
    if (text?.trim() && !state.hasText) return shown({ text, mode: 'append' });
  }
  return undefined;
};

/** By the parser FAMILY the catalog declares, which is what that field is for.
 *
 * The table above is keyed by COMMAND, so a harness that merely speaks
 * another vendor's stream shape needed a hand-written delegating entry --
 * `qwen: parsers.claude`, `kilo: parsers.opencode`. Three harnesses never got
 * one: Grok, Gemini and Amp all declare `claude-stream-json` and all fell
 * through to genericParser.
 *
 * That is not a cosmetic miss. On Claude's stream-json, genericParser appends
 * the text TWICE -- once from `content_block_delta`, then again from the
 * completed `assistant` message carrying the whole block -- because it has
 * none of the claude parser's sawDeltas guard. Every paragraph was printed
 * twice, bare-concatenated ("…policy work.I'll pick up from…"), which is what
 * the duplicated response on Grok actually was.
 *
 * Declaring the family is now enough; no harness needs an entry of its own to
 * reuse a parser. */
const parsersByFamily: Readonly<Record<string, ResponseParser>> = {
  'claude-stream-json': (value, harness) => parsers.claude!(value, harness),
  'opencode-json': (value, harness) => parsers.opencode!(value, harness),
  'cursor-stream-json': (value, harness) => parsers.cursor!(value, harness),
  'cline-json': (value, harness) => parsers.cline!(value, harness),
  'pi-json': (value, harness) => parsers.pi!(value, harness),
  antigravity: (value, harness) => parsers.antigravity!(value, harness),
  goose: (value, harness) => parsers.goose!(value, harness),
};

/** The response update carried by one already-parsed record. */
function nativeResponseUpdateFromValue(harness: AiLocalHarnessDefinition, value: unknown): NativeResponseUpdate | undefined {
  const record = object(value);
  if (!record || Array.isArray(value)) return undefined;
  // Command first, so a harness can still have a parser of its very own.
  const parser = parsers[harness.command]
    ?? (harness.parser ? parsersByFamily[harness.parser] : undefined)
    ?? genericParser;
  return parser(record, harness);
}

export function nativeResponseUpdate(harness: AiLocalHarnessDefinition, lineText: string): NativeResponseUpdate | undefined {
  return parseHarnessLine(harness, lineText).response;
}

export interface HarnessLineError { message: string; statusCode?: number; kind?: string }

interface ParsedHarnessLine {
  /** Live assistant text carried by this line. */
  response?: NativeResponseUpdate;
  /** First activity on the line (see `activities`). */
  activity?: NativeActivityEvent;
  /** Every activity on the line; a Claude message can carry several tool calls. */
  activities?: NativeActivityEvent[];
  phase?: 'generating response';
  usage?: NativeTurnUsage;
  sessionId?: string;
  error?: HarnessLineError;
}

const FAILED_STATUS = /^(?:error|failed)$/i;

function lineError(value: Json): HarnessLineError | undefined {
  const type = typeof value.type === 'string' ? value.type : '';
  if (/tool|function_call|command_execution|item/i.test(type)) return undefined;
  const errorObject = object(value.error);
  const failed = value.is_error === true || value.error === true || /(?:^|[._-])error(?:$|[._-])/i.test(type)
    || (typeof value.status === 'string' && FAILED_STATUS.test(value.status))
    || (typeof value.error === 'string' && Boolean(value.error.trim())) || Boolean(errorObject);
  if (!failed) return undefined;
  const message = stringValue(value.error, errorObject?.message, value.message, value.result, value.response) ?? 'harness reported an error';
  const statusCode = [value.api_error_status, value.status, errorObject?.status]
    .find((candidate): candidate is number => typeof candidate === 'number' && candidate >= 400);
  const kind = stringValue(errorObject?.type, errorObject?.code, typeof value.subtype === 'string' && /^error/i.test(value.subtype) ? value.subtype : undefined);
  return { message: message.trim(), ...(statusCode ? { statusCode } : {}), ...(kind ? { kind } : {}) };
}

/** Everything one stdout line means, from a single JSON.parse. The streaming
 * loop used to parse each line once per question it asked of it (response,
 * phase, activity, usage): four parses of what can be a multi-megabyte tool
 * result record. */
export function parseHarnessLine(harness: AiLocalHarnessDefinition, lineText: string): ParsedHarnessLine {
  // Plain-text harnesses print the answer itself and nativeTurnResult returns
  // that same stdout, so echoing each line live cannot diverge from what is
  // ultimately persisted. Without this they show nothing at all until the turn
  // ends, which on a long edit reads as a hung session.
  if (!parsers[harness.command] && harness.turn?.output === 'text') return { response: { text: `${lineText}\n`, mode: 'append' } };
  const candidate = lineText.trim();
  if (candidate[0] !== '{') return {};
  let value: Json;
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    value = parsed as Json;
  } catch {
    // fail-open-ok: vendors interleave non-JSON banners and progress chatter on
    // stdout. A line that does not parse carries no response update, so absence
    // is the answer rather than a swallowed failure.
    return {};
  }
  return parseHarnessValue(harness, value);
}

/** parseHarnessLine for a record the caller has already parsed. */
function parseHarnessValue(harness: AiLocalHarnessDefinition, value: Record<string, unknown>): ParsedHarnessLine {
  const response = nativeResponseUpdateFromValue(harness, value);
  const activities = parseNativeActivityEventsFromValue(harness, value);
  const phase = nativeActivityPhaseFromValue(harness, value);
  const usage = nativeUsageFromValue(value);
  const error = lineError(value);
  const sessionId = sessionIdOf(harness, value);
  return {
    ...(response ? { response } : {}),
    ...(activities.length ? { activity: activities[0], activities } : {}),
    ...(phase ? { phase } : {}), ...(usage ? { usage } : {}),
    ...(sessionId ? { sessionId } : {}), ...(error ? { error } : {}),
  };
}

/** Session identity sits on the record itself or one level down (Antigravity's
 * step_update); never walk a whole tool-result payload looking for it. */
function sessionIdOf(harness: AiLocalHarnessDefinition, value: Json): string | undefined {
  const shallow: Json = {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string') shallow[key] = child;
    else if (object(child) && !Array.isArray(child)) {
      shallow[key] = Object.fromEntries(Object.entries(child as Json).filter(([, nested]) => typeof nested === 'string'));
    }
  }
  return [...nativeSessionIdsFromValues([shallow], harness.command)][0];
}
