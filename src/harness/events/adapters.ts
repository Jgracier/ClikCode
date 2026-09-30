/** Provider event envelopes terminate here. The orchestrator and terminal UI
 * consume only normalized response updates, never vendor JSON shapes. */
import type { AiLocalHarnessDefinition } from '../definition.js';
import { aiderLine } from './aider.js';
import { ClaudeBlocks } from './claude-stream.js';
import { parseNativeActivityEventsFromValue, type NativeActivityEvent } from '../protocol/activity-events.js';
import { nativeActivityPhaseFromValue } from '../protocol/activity-line.js';
import { claudeShaped, parseJsonRecord } from '../protocol/json-lines.js';
import { TaskListTracker } from '../protocol/plan-events.js';
import { nativeSessionIdsFromValues } from '../protocol/session-ids.js';
import { nativeUsageFromValue, StreamUsageTally, type TurnUsage } from '../protocol/turn-usage.js';

interface NativeResponseUpdate { text: string; mode: 'append' | 'replace' }
type Json = Record<string, unknown>;
type ResponseParser = (value: Json, harness: AiLocalHarnessDefinition, turn: StreamState) => NativeResponseUpdate | undefined;

/** What one running turn attempt has seen of its stream. Several vendor
 * behaviours cannot be handled one line at a time: Claude's text blocks arrive
 * with no separator across a tool call, Cursor re-sends each streamed segment
 * as one full message, usage arrives per message and has to be summed, and a
 * tool call or a thought is announced before it is complete.
 *
 * Owned by the TURN: the transport creates one per attempt (createStreamState)
 * and hands it down with every line. It used to be a module-level map keyed by
 * harness + the record's own `session_id` -- which vendors put on SOME records
 * only. A generic harness whose text records carry none and whose `result`
 * carries one had its state split in two, so the final result looked like the
 * first text of a fresh stream and was appended again; and with no init record
 * to reset it, one turn's state leaked into the next. */
export interface StreamState {
  /** Any assistant text has been emitted this turn. */
  hasText: boolean;
  /** Real text deltas were seen, so whole-message records are repeats. */
  sawDeltas: boolean;
  /** Cursor: deltas accumulated since the last full-segment flush. */
  segment: string;
  /** Cursor: a delta-shaped repeat of the whole segment, until the next
   * record says whether it was a flush. */
  heldRepeat?: string;
  /** A tool call happened since the last text; the next text starts a paragraph. */
  needsSeparator: boolean;
  /** What has been shown so far already ends on a blank line. */
  atParagraph?: boolean;
  /** A plain-text harness with a banner before its answer (Aider): where in
   * the output this turn is. */
  textPhase?: 'banner' | 'reply' | 'done';
  /** Per-message usage, summed into the turn's. */
  readonly usage: StreamUsageTally;
  /** Claude-shaped content blocks in flight, created on first use. */
  claudeBlocks?: ClaudeBlocks;
  /** Tool calls started with no vendor id, oldest first, each under the id
   * synthesized for it (Pi builds that omit `toolCallId`). */
  readonly anonymousCalls: string[];
  anonymousCallCount: number;
  /** The turn's task list (Claude Code's task tools build it a call at a time). */
  readonly tasks: TaskListTracker;
}

/** A fresh state for one turn attempt. */
export function createStreamState(): StreamState {
  return {
    hasText: false, sawDeltas: false, segment: '', needsSeparator: false,
    usage: new StreamUsageTally(), anonymousCalls: [], anonymousCallCount: 0, tasks: new TaskListTracker(),
  };
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
function cursorDelta(state: StreamState, text: string): NativeResponseUpdate {
  state.segment += text;
  return appendText(state, text);
}

function cursorRecord(value: Json, state: StreamState): NativeResponseUpdate | undefined {
  if (value.type === 'tool_call') {
    if (state.hasText) state.needsSeparator = true;
    return undefined;
  }
  const message = value.type === 'assistant' ? object(value.message) : undefined;
  const text = contentText(message?.content);
  if (!text) return undefined;
  if (typeof value.timestamp_ms === 'number' && typeof value.model_call_id !== 'string') {
    if (state.segment && text === state.segment) {
      state.heldRepeat = text;
      return undefined;
    }
    return cursorDelta(state, text);
  }
  // A full-segment flush: emit only what the deltas have not already shown.
  const shown = state.segment;
  state.segment = '';
  if (!shown) return appendText(state, text);
  if (text === shown) return undefined;
  return appendText(state, text.startsWith(shown) ? text.slice(shown.length) : text);
}

const parsers: Readonly<Record<string, ResponseParser>> = {
  antigravity: (value) => {
    const step = value.event === 'step_update' ? object(value.step_update) : undefined;
    return step?.step_type === 'agent_response' && typeof step.text_delta === 'string' && step.text_delta
      ? { text: step.text_delta, mode: 'append' } : undefined;
  },
  claude: (value, _harness, state) => {
    // A subagent's words are its own, not the reply being written.
    if (typeof value.parent_tool_use_id === 'string' && value.parent_tool_use_id) return undefined;
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
  // -- before each tool call (timestamp_ms + model_call_id), once more at the
  // end (no timestamp_ms), and before a `retry` record (timestamp_ms alone,
  // shaped exactly like a delta). Appending those repeats printed every
  // segment twice. Without partial output only the full records exist.
  cursor: (value, _harness, state) => {
    // A delta-shaped record repeating the whole segment is either the flush
    // before a retry or a model that really said the same thing again; the
    // vendor's next record says which. Only a `retry` follows a flush.
    const held = state.heldRepeat;
    state.heldRepeat = undefined;
    if (held !== undefined && value.type === 'retry') {
      state.segment = '';
      return undefined;
    }
    const prefix = held === undefined ? '' : cursorDelta(state, held).text;
    const update = cursorRecord(value, state);
    return prefix ? { text: `${prefix}${update?.text ?? ''}`, mode: 'append' } : update;
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
const genericParser: ResponseParser = (value, _harness, state) => {
  const envelope = object(value.event) ?? value;
  const type = typeof envelope.type === 'string' ? envelope.type : '';
  if (NON_ASSISTANT_TYPE.test(type) || envelope.role === 'user') return undefined;
  const shown = (update: NativeResponseUpdate): NativeResponseUpdate => {
    if (update.text.trim()) state.hasText = true;
    state.atParagraph = /\n\s*\n\s*$/.test(update.text);
    return update;
  };
  /** A whole message after earlier text is a new paragraph -- the same rule
   * the Claude reader applies to a new text block. Joined bare, two messages
   * either side of a tool call read "Checking first.The commit is live." */
  const message = (text: string): NativeResponseUpdate => {
    const separator = state.hasText && !state.atParagraph && !/^\s*\n/.test(text) ? '\n\n' : '';
    return shown({ text: `${separator}${text}`, mode: 'append' });
  };
  const delta = object(envelope.delta);
  if (typeof delta?.text === 'string' && delta.text) return shown({ text: delta.text, mode: 'append' });
  const item = object(envelope.item);
  if (item && ASSISTANT_TEXT_TYPE.test(String(item.type ?? '')) && typeof item.text === 'string' && item.text) {
    return shown({ text: `${item.text}\n\n`, mode: 'append' });
  }
  const envelopeMessage = object(envelope.message);
  if (envelopeMessage && (envelopeMessage.role === undefined || envelopeMessage.role === 'assistant')) {
    const text = contentText(envelopeMessage.content) || stringValue(envelopeMessage.content, envelopeMessage.text);
    if (text) return message(text);
  }
  if (ASSISTANT_TEXT_TYPE.test(type)) {
    const text = contentText(envelope.content) || stringValue(envelope.text, object(envelope.part)?.text, envelope.content);
    if (text) return message(text);
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
export const parsersByFamily: Readonly<Record<string, ResponseParser>> = {
  'claude-stream-json': parsers.claude!,
  'opencode-json': parsers.opencode!,
  'cursor-stream-json': parsers.cursor!,
  'cline-json': parsers.cline!,
  'pi-json': parsers.pi!,
  antigravity: parsers.antigravity!,
  goose: parsers.goose!,
};

/** The response update carried by one already-parsed record. */
function nativeResponseUpdateFromValue(harness: AiLocalHarnessDefinition, record: Json, turn: StreamState): NativeResponseUpdate | undefined {
  // Command first, so a harness can still have a parser of its very own.
  const parser = parsers[harness.command]
    ?? (harness.parser ? parsersByFamily[harness.parser] : undefined)
    ?? genericParser;
  return parser(record, harness, turn);
}

export function nativeResponseUpdate(harness: AiLocalHarnessDefinition, lineText: string, turn: StreamState): NativeResponseUpdate | undefined {
  return parseHarnessLine(harness, lineText, turn).response;
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
  /** The turn's usage so far, when this line changed it. */
  usage?: TurnUsage;
  sessionId?: string;
  error?: HarnessLineError;
  /** The vendor's own end-of-turn record (`{type:"result"}` on Claude-shaped
   * streams, Cursor and Grok; `{event:"result"}` on Antigravity): whether the
   * turn it closes succeeded. A process still alive after a successful one has
   * already delivered its answer. */
  result?: 'success' | 'error';
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
 * phase, activity, usage, plan, self-report): six parses of what can be a
 * multi-megabyte tool result record. A caller that has already parsed the
 * line passes the record, and nothing here parses it again. */
export function parseHarnessLine(
  harness: AiLocalHarnessDefinition, lineText: string, turn: StreamState, record = parseJsonRecord(lineText),
): ParsedHarnessLine {
  // Plain-text harnesses print the answer itself and nativeTurnResult returns
  // that same stdout, so echoing each line live cannot diverge from what is
  // ultimately persisted. Without this they show nothing at all until the turn
  // ends, which on a long edit reads as a hung session.
  if (harness.parser === 'aider') return aiderLine(lineText, turn);
  if (!parsers[harness.command] && harness.turn?.output === 'text') return { response: { text: `${lineText}\n`, mode: 'append' } };
  // A line that is not a record (a banner, progress chatter) carries nothing.
  return record ? parseHarnessValue(harness, record, turn) : {};
}

/** parseHarnessLine for a record the caller has already parsed. */
function parseHarnessValue(harness: AiLocalHarnessDefinition, value: Json, turn: StreamState): ParsedHarnessLine {
  const response = nativeResponseUpdateFromValue(harness, value, turn);
  const activities = pairAnonymousCalls(harness, turn, value, [
    ...(claudeShaped(harness) ? (turn.claudeBlocks ??= new ClaudeBlocks(harness.command)).note(value) : []),
    ...parseNativeActivityEventsFromValue(harness, value),
  ]);
  const phase = nativeActivityPhaseFromValue(harness, value);
  // The terminal record's own totals, else the running sum of per-message usage.
  const usage = nativeUsageFromValue(value) ?? turn.usage.note(value);
  const error = lineError(value);
  const sessionId = sessionIdOf(harness, value);
  // Antigravity nests its status: {event:"result", result:{status:"ERROR"}}.
  const nested = object(value.result);
  const nestedFailed = typeof nested?.status === 'string' && FAILED_STATUS.test(nested.status);
  const result = value.type === 'result' || value.event === 'result' ? (error || nestedFailed ? 'error' : 'success') : undefined;
  return {
    ...(result ? { result } : {}),
    ...(response ? { response } : {}),
    ...(activities.length ? { activity: activities[0], activities } : {}),
    ...(phase ? { phase } : {}), ...(usage ? { usage } : {}),
    ...(sessionId ? { sessionId } : {}), ...(error ? { error } : {}),
  };
}

/** A tool call a harness reports with no id is given one, and its completion
 * settles the oldest call still open -- a per-call sequence, where a label
 * would pair two runs of the same tool with each other's results. Pi builds
 * before `toolCallId` are the case (activity-events.ts). */
function pairAnonymousCalls(harness: AiLocalHarnessDefinition, turn: StreamState, value: Json, events: NativeActivityEvent[]): NativeActivityEvent[] {
  // Only the execution pair: `toolcall_start` names its call from the message itself.
  if (harness.command !== 'pi' || !/^tool_execution_(?:start|end)$/.test(String(value.type))) return events;
  return events.map((event) => {
    if (event.id || event.kind === 'thinking') return event;
    if (event.kind === 'tool-start') {
      const id = `call-${++turn.anonymousCallCount}`;
      turn.anonymousCalls.push(id);
      return { ...event, id };
    }
    const id = turn.anonymousCalls.shift();
    return id ? { ...event, id } : event;
  });
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
