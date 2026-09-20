/** Harness-protocol classification and parsing -- the router runtime
 * bridge, capability checks, and per-vendor turn/activity-event parsing.
 * Everything here is pure request/response shaping: given a harness
 * definition and some raw text a vendor CLI produced, what does it mean?
 * No session/account state, no I/O beyond the router runtime require. */

import chalk from 'chalk';
import { visibleSlice } from './markdown-render.js';
import { homedir } from 'node:os';
import { localHarnessForCommand } from './harness-runtime.js';
export { nativeResponseUpdate, type NativeResponseUpdate } from './harness-event-adapters.js';
import type {
  AiHarnessAccount, AiLocalHarnessDefinition,
  HarnessActivityEvent, HarnessSession,
} from './types.js';
export {
  harnessIntegrationLevel, harnessSupportsEffort, harnessSupportsImages, harnessSupportsPermissionMode,
  localHarnessCapabilityManifest, localHarnessForCommand, localHarnessForProvider, localRouter, streamLocalAiTurn,
} from './harness-runtime.js';

type JsonRecord = Record<string, unknown>;
const asRecord = (value: unknown): JsonRecord | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined;

function recordsOf(parsed: unknown): JsonRecord[] {
  const out: JsonRecord[] = [];
  for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
    const record = asRecord(item);
    if (record) out.push(record);
  }
  return out;
}

/** Harnesses whose stream is Claude Code's stream-json, or OpenCode's. */
const CLAUDE_SHAPED = new Set(['claude', 'qwen']);
const OPENCODE_SHAPED = new Set(['opencode', 'kilo']);

/** Vendors interleave banners, deprecation warnings and progress chatter with
 * their JSON records. The streaming adapter has always skipped such lines; the
 * final-result parsers must agree with it, or a turn the user watched succeed
 * is reported as failed because of one warning line. */
export function parseJsonLines(text: string): { values: JsonRecord[]; skipped: string[] } {
  const values: JsonRecord[] = [];
  const skipped: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const candidate = line.trim();
    if (!candidate) continue;
    if (candidate[0] !== '{' && candidate[0] !== '[') { skipped.push(candidate); continue; }
    try {
      const parsed: unknown = JSON.parse(candidate);
      const records = recordsOf(parsed);
      if (records.length) values.push(...records);
      else skipped.push(candidate);
    } catch {
      skipped.push(candidate); // fail-open-ok: a non-JSON line is not a record
    }
  }
  return { values, skipped };
}

/** A single JSON document, tolerating a banner before or after it. */
function parseJsonDocument(text: string): JsonRecord[] {
  const attempt = (candidate: string): JsonRecord[] | undefined => {
    try {
      const parsed: unknown = JSON.parse(candidate);
      const records = recordsOf(parsed);
      return records.length ? records : undefined;
    } catch { return undefined; } // fail-open-ok: caller falls through to the next strategy
  };
  const whole = attempt(text.trim());
  if (whole) return whole;
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const framed = attempt(text.slice(first, last + 1));
    if (framed) return framed;
  }
  return parseJsonLines(text).values;
}

const SESSION_KEY = /^(?:session_?id|thread_?id|chat_?id|conversation_?id|session)$/i;
/** The key each vendor documents for its own resumable identity. A harness
 * listed here never has another key's value preferred over this one. */
const HARNESS_SESSION_KEYS: Readonly<Record<string, readonly string[]>> = {
  claude: ['session_id'], qwen: ['session_id'], cursor: ['session_id'], gemini: ['session_id'],
  droid: ['session_id'], pi: ['session_id', 'sessionId'], codex: ['thread_id'],
  antigravity: ['conversation_id'], opencode: ['sessionID'], kilo: ['sessionID'],
};
/** Envelopes that introduce a session, where a bare `id` IS the session id. */
const SESSION_ENVELOPE_TYPE = /(?:^|[._-])(?:session|thread|conversation|chat|init|task)(?:$|[._-])/i;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;

/** Session identities found in a turn's output, most trustworthy first.
 *
 * Structured output is only ever read through explicit keys (the harness's own
 * documented key first), plus a bare `id` on a top-level session-introducing
 * envelope. The generic "any `id`" and "any UUID in the text" heuristics are
 * reserved for text-mode harnesses: in a JSON stream they match tool-call ids
 * and UUIDs the model merely printed, and a wrong id silently forks the
 * conversation on the next resume. */
export function nativeSessionIds(
  outputText: string, format: 'json' | 'json-lines' | 'text' = 'text', harnessCommand?: string,
): Set<string> {
  if (format === 'text') {
    const ids = new Set<string>();
    const labelled = /(?:session|thread|chat|conversation)(?:\s+id)?\s*[:=]\s*([\w-]{8,})/i.exec(outputText)?.[1];
    if (labelled) ids.add(labelled);
    for (const match of outputText.matchAll(UUID)) ids.add(match[0]);
    return ids;
  }
  return nativeSessionIdsFromValues(format === 'json' ? parseJsonDocument(outputText) : parseJsonLines(outputText).values, harnessCommand);
}

/** nativeSessionIds over already-parsed structured records. */
export function nativeSessionIdsFromValues(values: readonly unknown[], harnessCommand?: string): Set<string> {
  const preferredKeys = new Set(harnessCommand ? HARNESS_SESSION_KEYS[harnessCommand] ?? [] : []);
  const preferred = new Set<string>();
  const explicit = new Set<string>();
  const envelope = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (Array.isArray(value)) return value.forEach((item) => visit(item, depth + 1));
    const record = asRecord(value);
    if (!record) return;
    for (const [key, child] of Object.entries(record)) {
      if (typeof child === 'string') {
        if (!child.trim()) continue;
        if (preferredKeys.has(key)) preferred.add(child.trim());
        else if (SESSION_KEY.test(key)) explicit.add(child.trim());
        else if (key === 'id' && depth === 0 && SESSION_ENVELOPE_TYPE.test(String(record.type ?? record.event ?? ''))) envelope.add(child.trim());
      } else visit(child, depth + 1);
    }
  };
  for (const value of values) visit(value, 0);
  return new Set<string>([...preferred, ...explicit, ...envelope]);
}

export interface NativeTurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  totalTokens?: number;
  totalCostUsd?: number;
  durationMs?: number;
  numTurns?: number;
}

const finiteNumber = (...candidates: unknown[]): number | undefined =>
  candidates.find((candidate): candidate is number => typeof candidate === 'number' && Number.isFinite(candidate));

/** Usage reported by one record, if it is a usage-bearing terminal record. */
export function nativeUsageFromValue(value: unknown): NativeTurnUsage | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const type = String(record.type ?? '');
  // Only terminal/summary records: per-message usage on an `assistant` event is
  // a partial count that the final record supersedes.
  if (type && !/(?:^|[._-])(?:result|complete|completed|finish|finished|done|usage|stats?)(?:$|[._-])/i.test(type)) return undefined;
  const usage = asRecord(record.usage) ?? asRecord(record.stats) ?? asRecord(record.token_usage) ?? asRecord(asRecord(record.part)?.tokens);
  const cache = asRecord(usage?.cache);
  const result: NativeTurnUsage = {};
  const assign = <K extends keyof NativeTurnUsage>(key: K, number: number | undefined): void => { if (number !== undefined) result[key] = number; };
  assign('inputTokens', finiteNumber(usage?.input_tokens, usage?.inputTokens, usage?.prompt_tokens, usage?.input));
  assign('outputTokens', finiteNumber(usage?.output_tokens, usage?.outputTokens, usage?.completion_tokens, usage?.output));
  assign('cacheReadTokens', finiteNumber(usage?.cache_read_input_tokens, usage?.cached_input_tokens, usage?.cacheReadTokens, usage?.cached, cache?.read));
  assign('cacheCreationTokens', finiteNumber(usage?.cache_creation_input_tokens, usage?.cacheWriteTokens, cache?.write));
  assign('totalTokens', finiteNumber(usage?.total_tokens, usage?.totalTokens, usage?.total));
  assign('totalCostUsd', finiteNumber(record.total_cost_usd, record.cost_usd, record.totalCostUsd, usage?.total_cost_usd, asRecord(record.part)?.cost));
  assign('durationMs', finiteNumber(record.duration_ms, record.durationMs));
  assign('numTurns', finiteNumber(record.num_turns, record.numTurns));
  return Object.keys(result).length ? result : undefined;
}

/** Token usage and cost from the turn's final usage-bearing record (Claude's
 * `result`: usage.*_tokens + total_cost_usd; Codex's `turn.completed`; ...).
 * Accepts raw stdout or already-parsed events. */
export function nativeTurnUsage(
  harness: AiLocalHarnessDefinition, output: string | readonly unknown[],
): NativeTurnUsage | undefined {
  const values = typeof output === 'string'
    ? (harness.turn?.output === 'json' ? parseJsonDocument(output) : harness.turn?.output === 'text' ? [] : parseJsonLines(output).values)
    : output;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const usage = nativeUsageFromValue(values[index]);
    if (usage) return usage;
  }
  return undefined;
}

export interface NativeTurnResult {
  text: string;
  nativeSessionId?: string;
  isError?: boolean;
  statusCode?: number;
  /** The turn did real work (tool calls) but the model wrote no prose. `text`
   * is empty; this is a successful turn, not a failure. */
  noAssistantText?: boolean;
  /** Vendor's own machine-readable failure kind (`error.type`, or an
   * `error_*` result subtype), for classification without regex. */
  errorKind?: string;
  /** Latest `rate_limit_event` status, e.g. 'allowed' | 'allowed_warning' | 'rejected'. */
  rateLimitStatus?: string;
  usage?: NativeTurnUsage;
}

/** Top-level assistant prose of a Claude-shaped stream, in order. Text blocks
 * separated by tool calls are separate paragraphs: joining them bare produced
 * "Let me check.Found it." Subagent messages (parent_tool_use_id) are the
 * subagent's words, not the reply. */
function claudeShapedText(values: readonly JsonRecord[]): string {
  const blocks: string[] = [];
  for (const value of values) {
    if (value.type !== 'assistant' || (typeof value.parent_tool_use_id === 'string' && value.parent_tool_use_id)) continue;
    const content = asRecord(value.message)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const block = asRecord(part);
      if (block?.type !== 'text' || typeof block.text !== 'string' || !block.text.trim()) continue;
      if (blocks[blocks.length - 1] !== block.text.trim()) blocks.push(block.text.trim());
    }
  }
  return blocks.join('\n\n');
}

export function nativeTurnResult(harness: AiLocalHarnessDefinition, stdout: string): NativeTurnResult {
  if (!harness.turn) throw new Error(`${harness.displayName} has no centralized turn adapter`);
  if (harness.turn.output === 'text') {
    const text = stdout.trim();
    if (!text) throw new Error(`${harness.displayName} returned no assistant text`);
    const nativeSessionId = /(?:session|thread|chat)(?:\s+id)?\s*[:=]\s*([\w-]{8,})/i.exec(stdout)?.[1];
    return { text, ...(nativeSessionId ? { nativeSessionId } : {}) };
  }
  const values = harness.turn.output === 'json' ? parseJsonDocument(stdout) : parseJsonLines(stdout).values;
  if (values.length === 0) {
    const sample = stdout.trim().split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 300);
    throw Object.assign(
      new Error(`${harness.displayName} returned invalid ${harness.turn.output} output: no JSON record found${sample ? ` (${sample})` : ''}`),
      { stdoutTail: stdout.trim().slice(-4000) },
    );
  }
  const fields = new Set(harness.turn.responseFields ?? ['result', 'response', 'text', 'content']);
  const messages: string[] = [];
  let isError = false;
  let statusCode: number | undefined;
  let errorKind: string | undefined;
  let rateLimitStatus: string | undefined;
  // Distinct from `messages`: a string `error` field is a failure reason,
  // never the assistant's own reply, so it must never end up as the
  // returned "text" for a successful-looking turn -- but without capturing
  // it separately, a genuine failure with no text in any of `fields` (a
  // real, verified shape: Antigravity CLI's own {status:"ERROR",
  // error:"API error...", response:""}) surfaced only as a generic
  // "returned no assistant text", discarding the real reason entirely.
  let errorMessage: string | undefined;
  const visit = (value: unknown, parentType?: string): void => {
    if (Array.isArray(value)) return value.forEach((item) => visit(item, parentType));
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const type = typeof record.type === 'string' ? record.type : parentType;
    // A failed tool/command item is not a failed turn. Codex's public JSONL
    // stream does not preserve the internal `source` field we previously
    // used to distinguish those cases: it emits an item.completed envelope
    // containing {type:"command_execution", status:"failed"}. Classify by
    // the event's semantic type instead, so a later agent_message remains a
    // successful answer. Untyped objects remain terminal because several
    // providers (verified with Antigravity) return a bare
    // {status:"ERROR", error:"...", response:""} result object.
    // `tool_result` contains the word "result" but is a tool's outcome: a
    // Claude tool_result block with is_error:true is a failed tool, and the
    // model routinely recovers from it and still answers.
    const toolScoped = Boolean(type) && /tool|function_call|command_execution/i.test(type!);
    const terminalEnvelope = !toolScoped && (!type || /(?:^|[._-])(?:assistant|agent|message|result|response|turn|session|final)(?:$|[._-])/i.test(type));
    if (terminalEnvelope && (record.is_error === true || record.error === true || (typeof record.status === 'string' && /^(error|failed)$/i.test(record.status)))) {
      isError = true;
      if (typeof record.subtype === 'string' && /^error/i.test(record.subtype)) errorKind = record.subtype;
    }
    if (typeof record.api_error_status === 'number') statusCode = record.api_error_status;
    else if (typeof record.status === 'number' && record.status >= 400) statusCode = record.status;
    if (!toolScoped && typeof record.error === 'string' && record.error.trim()) errorMessage = record.error.trim();
    const errorObject = toolScoped ? undefined : asRecord(record.error);
    if (errorObject) {
      if (typeof errorObject.type === 'string') errorKind = errorObject.type;
      else if (typeof errorObject.code === 'string') errorKind = errorObject.code;
      if (typeof errorObject.message === 'string' && errorObject.message.trim()) errorMessage = errorObject.message.trim();
      if (typeof errorObject.status === 'number' && errorObject.status >= 400) statusCode = errorObject.status;
    }
    if (type === 'rate_limit_event') {
      const info = asRecord(record.rate_limit_info);
      if (typeof info?.status === 'string') rateLimitStatus = info.status;
    }
    for (const [key, child] of Object.entries(record)) {
      if (fields.has(key) && typeof child === 'string' && child.trim()) {
        // JSON event streams often contain tool input and user echoes. Only
        // accept generic text/content from assistant/result-shaped events.
        if (!['text', 'content'].includes(key) || !type || /assistant|agent|message|result|complete|text|say/i.test(type)) messages.push(child.trim());
      } else visit(child, type);
    }
  };
  values.forEach((value) => visit(value));
  // Gemini's stream-json terminal result contains statistics rather than a
  // repeated final response. Its assistant `message` records are genuine
  // incremental chunks, so reconstruct them in order instead of returning
  // only the final chunk collected by the generic structured-output walk.
  const geminiStreamText = harness.command === 'gemini'
    ? values.flatMap((record) => record.type === 'message' && record.role === 'assistant' && typeof record.content === 'string'
      ? [record.content]
      : []).join('')
    : '';
  const gooseStreamText = harness.command === 'goose'
    ? values.flatMap((record) => {
      const message = asRecord(record.message);
      if (record.type !== 'message' || message?.role !== 'assistant' || !Array.isArray(message.content)) return [];
      return message.content.flatMap((part) => part && typeof part === 'object'
        && (part as Record<string, unknown>).type === 'text' && typeof (part as Record<string, unknown>).text === 'string'
        ? [String((part as Record<string, unknown>).text)] : []);
    }).join('')
    : '';
  // Some harnesses report a bare string `error` without also setting an
  // is_error flag or top-level failed status. When no assistant message was
  // produced, that string is still a turn failure rather than a successful
  // reply. This matters now that process exit codes are only advisory: a
  // non-zero exit must not be the sole signal preserving this failure.
  if (messages.length === 0 && errorMessage) isError = true;
  // A failed Claude-shaped turn reports its reason in `result`; a successful
  // one reports only the LAST text block there, dropping everything the model
  // said before its final tool call -- text the user already watched stream.
  const claudeText = !isError && CLAUDE_SHAPED.has(harness.command) ? claudeShapedText(values) : '';
  // errorMessage only as a fallback, never preferred over real assistant
  // text -- a turn that produced actual output before failing partway
  // through should still show that output, not the failure reason instead
  // of it.
  const text = claudeText || geminiStreamText.trim() || gooseStreamText.trim() || messages[messages.length - 1]?.trim() || errorMessage;
  const ids = nativeSessionIdsFromValues(values, harness.command);
  const usage = nativeTurnUsage(harness, values);
  const extras = {
    ...(ids.size ? { nativeSessionId: [...ids][0] } : {}),
    ...(statusCode ? { statusCode } : {}), ...(errorKind ? { errorKind } : {}),
    ...(rateLimitStatus ? { rateLimitStatus } : {}), ...(usage ? { usage } : {}),
  };
  if (!text) {
    // Work without words is still work: "fix the lint errors" can legitimately
    // end after the last Edit with nothing to add. Rejecting it threw away a
    // successful turn and, worse, invited a replay of edits already applied.
    const didToolWork = values.some((value) => parseNativeActivityEventsFromValue(harness, value).some((event) => event.kind !== 'thinking'));
    if (!isError && didToolWork) return { text: '', noAssistantText: true, ...extras };
    throw new Error(`${harness.displayName} returned no assistant text in its structured output`);
  }
  return { text, ...(isError ? { isError } : {}), ...extras };
}

/** Render provider JSONL as a small provider-neutral activity stream. */
/**
 * Every harness's own JSON envelope is a different shape (Codex's generic
 * `item.type` + `started`/`completed` states, Claude's `stream-json` content
 * array, opencode's top-level `type` with a `part` object) -- but what a user
 * actually needs to see collapses into the same handful of things happening:
 * the model is thinking, a tool started, a tool finished, or it's generating
 * the reply text. This is that common shape: each vendor's parser below maps
 * its own real, verified envelope into one of these, and exactly one
 * renderer (below) turns any of them into the same glyph/color/wording
 * regardless of which harness produced it -- a Codex tool call and a Claude
 * Code tool call read identically once they reach here.
 */

/** Line-capped, not byte-capped: a diff that's still readable at a glance
 * beats a byte-perfect one that pushes everything else out of the 5-line
 * activity window. */
/** Captured per side, so a balanced preview always has something to show from
 * both halves of an edit. */
const DIFF_CAPTURE_LINES = 8;

/** How much of a tool's work a transcript row shows. Enough to recognise the
 * edit or command at a glance without the trail crowding out the answer. */
const ACTIVITY_PREVIEW_LINES = 8;

/** `Edit(src/app.ts)` rather than a bare `Edit`. The tool name alone says
 * nothing about what was touched; every vendor carries the target in the
 * call's input under one of a few well-known keys. */
export function toolLabel(name: string, input?: Record<string, unknown>): string {
  const target = ['file_path', 'filePath', 'path', 'notebook_path', 'command', 'pattern', 'query', 'url']
    .map((key) => input?.[key])
    .find((value): value is string => typeof value === 'string' && Boolean(value.trim()));
  if (!target) return name;
  const firstLine = target.split(/\r?\n/, 1)[0]!.trim();
  return firstLine ? `${name}(${visibleSlice(firstLine, 72)})` : name;
}

export function capDiffLines(text: string, max: number): { lines: string[]; truncated: number } {
  const all = text.split(/\r?\n/);
  return { lines: all.slice(0, max), truncated: Math.max(0, all.length - max) };
}

function cappedActivityOutput(text: string): string[] | undefined {
  const normalized = text.trim();
  if (!normalized) return undefined;
  // Machine-readable tool output belongs to the native event protocol, not
  // the human transcript. Printing JSON/JSONL here was the reason a working
  // turn looked like a wall of tool-call envelopes until the final response
  // replaced it. Keep the useful tool label/status and omit its raw payload.
  const records = normalized.split(/\r?\n/).filter(Boolean);
  const isJson = (candidate: string): boolean => {
    if (!/^(?:\{|\[)/.test(candidate.trim())) return false;
    try { JSON.parse(candidate); return true; } catch { return false; }
  };
  if (isJson(normalized) || (records.length > 0 && records.every(isJson))) return undefined;
  const capped = capDiffLines(normalized, 3);
  return [...capped.lines, ...(capped.truncated ? [`… ${capped.truncated} more line${capped.truncated === 1 ? '' : 's'}`] : [])];
}

/** HarnessActivityEvent plus the id of the tool call that spawned it, when the
 * activity belongs to a subagent (Claude's `parent_tool_use_id`). Structurally
 * a HarnessActivityEvent, so it can be passed anywhere one is accepted. */
export type NativeActivityEvent = HarnessActivityEvent & { parentId?: string };

const truncationNote = (count: number): string[] => count ? [`… ${count} more line${count === 1 ? '' : 's'}`] : [];

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((part) => {
    const record = asRecord(part);
    return typeof record?.text === 'string' ? [record.text] : [];
  }).join('\n');
}

/** One Claude-shaped `tool_use` block. */
function claudeToolStart(tool: JsonRecord): NativeActivityEvent {
  const name = String(tool.name ?? 'tool');
  const input = asRecord(tool.input);
  const identity = typeof tool.id === 'string' ? { id: tool.id } : {};
  // Verified against a real session transcript: Edit's input carries
  // old_string/new_string verbatim, Write carries the full new file as
  // `content` with no prior text to diff against.
  if (name === 'Edit' && typeof input?.old_string === 'string' && typeof input?.new_string === 'string') {
    const removed = capDiffLines(input.old_string, DIFF_CAPTURE_LINES);
    const added = capDiffLines(input.new_string, DIFF_CAPTURE_LINES);
    return {
      kind: 'tool-start', label: toolLabel(name, input), ...identity,
      diff: { removed: [...removed.lines, ...truncationNote(removed.truncated)], added: [...added.lines, ...truncationNote(added.truncated)] },
    };
  }
  if (name === 'Write' && typeof input?.content === 'string') {
    const added = capDiffLines(input.content, DIFF_CAPTURE_LINES);
    return { kind: 'tool-start', label: toolLabel(name, input), ...identity, diff: { removed: [], added: [...added.lines, ...truncationNote(added.truncated)] } };
  }
  return { kind: 'tool-start', label: toolLabel(name, input), ...identity };
}

/** Every activity one record describes. A single Claude message routinely
 * carries several parallel tool_use blocks (and the following user message all
 * of their tool_results); reporting only the first left the rest running
 * forever in the UI and unrecorded in the checkpoint. */
export function parseNativeActivityEventsFromValue(harness: AiLocalHarnessDefinition, parsed: unknown): NativeActivityEvent[] {
  const value = asRecord(parsed);
  if (!value) return [];
  if (CLAUDE_SHAPED.has(harness.command)) {
    const claude = claudeShapedActivity(value);
    if (claude) return claude;
  }
  if (harness.command === 'goose') {
    const goose = gooseActivity(value);
    if (goose) return goose;
  }
  const single = singleActivityEvent(harness, value);
  return single ? [single] : [];
}

export function parseNativeActivityEvents(harness: AiLocalHarnessDefinition, lineText: string): NativeActivityEvent[] {
  const candidate = lineText.trim();
  if (candidate[0] !== '{') return [];
  try {
    return parseNativeActivityEventsFromValue(harness, JSON.parse(candidate));
  } catch {
    // fail-open-ok: plain-text harness output has no structured activity metadata to parse.
    return [];
  }
}

/** First activity on the line. Prefer parseNativeActivityEvents: a line can
 * describe several. */
export function parseNativeActivityEvent(harness: AiLocalHarnessDefinition, lineText: string): NativeActivityEvent | undefined {
  return parseNativeActivityEvents(harness, lineText)[0];
}

/** Claude Code stream-json (also Qwen Code). Returns undefined for records
 * this shape does not own, so the generic branches still get a look. */
function claudeShapedActivity(value: JsonRecord): NativeActivityEvent[] | undefined {
  const type = String(value.type ?? '');
  const parent = typeof value.parent_tool_use_id === 'string' && value.parent_tool_use_id ? { parentId: value.parent_tool_use_id } : {};
  if (type === 'system' || type === 'result' || type === 'rate_limit_event') return [];
  if (type === 'stream_event') {
    // The completed block (below) carries the thinking text; the block START is
    // what tells the UI the model has gone quiet because it is thinking.
    const event = asRecord(value.event);
    const block = asRecord(event?.content_block);
    return event?.type === 'content_block_start' && (block?.type === 'thinking' || block?.type === 'redacted_thinking')
      ? [{ kind: 'thinking', label: 'thinking', ...parent }] : [];
  }
  const content = asRecord(value.message)?.content;
  if (type === 'assistant') {
    if (!Array.isArray(content)) return [];
    return content.flatMap((part): NativeActivityEvent[] => {
      const block = asRecord(part);
      if (block?.type === 'tool_use' || block?.type === 'server_tool_use') return [{ ...claudeToolStart(block), ...parent }];
      if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
        return [{ kind: 'thinking', label: visibleSlice(block.thinking.trim().replace(/\s+/g, ' '), 140), ...parent }];
      }
      return [];
    });
  }
  if (type === 'user') {
    if (!Array.isArray(content)) return [];
    return content.flatMap((part): NativeActivityEvent[] => {
      const result = asRecord(part);
      if (result?.type !== 'tool_result') return [];
      const output = cappedActivityOutput(blockText(result.content));
      return [{
        kind: result.is_error === true ? 'tool-error' : 'tool-done', label: 'tool',
        ...(typeof result.tool_use_id === 'string' ? { id: result.tool_use_id } : {}),
        ...(output?.length ? { output } : {}), ...parent,
      }];
    });
  }
  return undefined;
}

/** Goose stream-json: `{type:'message', message:{role, content:[...]}}` where
 * content parts are Goose's own Message serialization -- `toolRequest`
 * ({id, toolCall:{status, value:{name, arguments}}}) on assistant messages and
 * `toolResponse` ({id, toolResult:{status, value|error}}) on user messages. */
function gooseActivity(value: JsonRecord): NativeActivityEvent[] | undefined {
  if (value.type !== 'message') return undefined;
  const content = asRecord(value.message)?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((part): NativeActivityEvent[] => {
    const block = asRecord(part);
    const identity = typeof block?.id === 'string' ? { id: block.id } : {};
    if (block?.type === 'toolRequest') {
      const call = asRecord(block.toolCall);
      const detail = asRecord(call?.value) ?? call;
      const name = String(detail?.name ?? 'tool');
      if (call?.status === 'error') return [{ kind: 'tool-error', label: name, ...identity }];
      return [{ kind: 'tool-start', label: toolLabel(name, asRecord(detail?.arguments)), ...identity }];
    }
    if (block?.type === 'toolResponse') {
      const result = asRecord(block.toolResult);
      const failed = result?.status === 'error' || result?.isError === true || asRecord(result?.value)?.isError === true;
      const payload = Array.isArray(result?.value) ? result.value : asRecord(result?.value)?.content;
      const output = cappedActivityOutput(blockText(payload));
      return [{ kind: failed ? 'tool-error' : 'tool-done', label: 'tool', ...identity, ...(output?.length ? { output } : {}) }];
    }
    if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
      return [{ kind: 'thinking', label: visibleSlice(block.thinking.trim().replace(/\s+/g, ' '), 140) }];
    }
    return [];
  });
}

function singleActivityEvent(harness: AiLocalHarnessDefinition, value: JsonRecord): NativeActivityEvent | undefined {
  const type = String(value.type ?? '');
  if (harness.command === 'antigravity' && value.event === 'step_update') {
    const step = value.step_update && typeof value.step_update === 'object' ? value.step_update as Record<string, unknown> : undefined;
    if (step?.step_type === 'tool') {
      const state = String(step.state ?? '');
      return {
        kind: /error|fail/i.test(state) ? 'tool-error' : state === 'DONE' ? 'tool-done' : 'tool-start',
        label: String(step.tool_name ?? 'tool'),
      };
    }
  }
  const item = value.item && typeof value.item === 'object' ? value.item as Record<string, unknown> : undefined;
  const itemType = String(item?.type ?? '');
  const reasoningSummary = (candidate: unknown): string | undefined => {
    if (typeof candidate === 'string') return candidate.trim() || undefined;
    if (!Array.isArray(candidate)) return undefined;
    const text = candidate.flatMap((part) => {
      if (typeof part === 'string') return [part];
      if (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') return [String((part as Record<string, unknown>).text)];
      return [];
    }).join(' ').trim();
    return text || undefined;
  };
  if (type === 'thread.started' || type === 'turn.started') return undefined;
  if (/reasoning|thinking/.test(itemType) && /completed|done/.test(type)) {
    const summary = reasoningSummary(item?.summary) ?? reasoningSummary(item?.text) ?? reasoningSummary(item?.content);
    return summary ? { kind: 'thinking', label: visibleSlice(summary.replace(/\s+/g, ' '), 140) } : undefined;
  }
  if (/command_execution/.test(itemType) && /started|completed/.test(type)) {
    const command = String(item?.command ?? item?.command_line ?? '').trim();
    const startedId = typeof item?.id === 'string' ? item.id : undefined;
    // A `started` event often carries no command text yet. Dropping it meant
    // the tool was first recorded at its COMPLETION, which anchored the row
    // after everything the model said while the tool was running -- so that
    // prose rendered above the tool call that produced it. Emit the start
    // keyed by its id; the completion upserts the real label and output onto
    // this same row, at the position where the tool actually began.
    if (!command) {
      return type.endsWith('completed') || !startedId ? undefined : { kind: 'tool-start', label: 'tool', id: startedId };
    }
    const rawOutput = typeof item?.aggregated_output === 'string' ? item.aggregated_output
      : typeof item?.output === 'string' ? item.output : '';
    const output = cappedActivityOutput(rawOutput);
    return {
      kind: type.endsWith('completed')
        ? (item?.status === 'failed' || item?.status === 'error'
          || (typeof item?.exit_code === 'number' && item.exit_code !== 0)
          || (typeof item?.exitCode === 'number' && item.exitCode !== 0) ? 'tool-error' : 'tool-done')
        : 'tool-start', label: command,
      ...(typeof item?.id === 'string' ? { id: item.id } : {}),
      ...(output?.length ? { output } : {}),
    };
  }
  if (/file_change/.test(itemType) && /started|completed/.test(type)) {
    return {
      kind: type.endsWith('completed')
        ? (item?.status === 'failed' || item?.status === 'error' ? 'tool-error' : 'tool-done')
        : 'tool-start', label: 'files updated',
      ...(typeof item?.id === 'string' ? { id: item.id } : {}),
    };
  }
  if (/mcp_tool_call|tool_use|tool_call/.test(itemType) && /started|completed/.test(type)) {
    const name = String(item?.name ?? item?.server ?? 'tool');
    return {
      kind: type.endsWith('completed')
        ? (item?.status === 'failed' || item?.status === 'error' ? 'tool-error' : 'tool-done')
        : 'tool-start', label: name,
      ...(typeof item?.id === 'string' ? { id: item.id } : {}),
    };
  }
  // opencode's own envelope is a different shape entirely: a top-level `type`
  // (not nested under `item`) and a `part` object instead of an `item` one.
  // Verified against a real `opencode run --format json` turn, including one
  // that actually called a tool — `part.tool` is the tool name and
  // `part.state.status` tracks completion.
  // Kilo Code CLI is an OpenCode fork and emits the same envelope.
  if (OPENCODE_SHAPED.has(harness.command) && type === 'tool_use') {
    const part = asRecord(value.part);
    const state = asRecord(part?.state);
    const name = String(part?.tool ?? 'tool');
    const status = String(state?.status ?? '');
    const output = typeof state?.output === 'string' ? cappedActivityOutput(state.output) : undefined;
    return {
      kind: /error|fail/i.test(status) ? 'tool-error' : status === 'completed' ? 'tool-done' : 'tool-start',
      label: toolLabel(name, asRecord(state?.input)),
      ...(typeof part?.callID === 'string' ? { id: part.callID } : typeof part?.id === 'string' ? { id: part.id } : {}),
      ...(output?.length ? { output } : {}),
    };
  }
  // Command Code wraps each lifecycle event under a top-level
  // `{ type: 'event', event: {...} }` (distinct from its `{ type: 'result' }`
  // terminal frame). The event names and payloads below are read from the
  // published CLI itself (command-code 1.58 dist/cli.mjs): every tool emits
  // tool_running {toolCallId, toolName, description} and then exactly one of
  // tool_completed {toolCallId, toolName, result:[content blocks]} or
  // tool_errored {toolCallId, toolName, error}; a refused call emits
  // tool_denied / tool_hook_blocked instead of ever running.
  if (harness.command === 'command') {
    const inner = type === 'event' ? asRecord(value.event) : value;
    const innerType = String(inner?.type ?? '');
    const kind = innerType === 'tool_running' ? 'tool-start' as const
      : innerType === 'tool_completed' ? 'tool-done' as const
        : /^tool_(?:errored|denied|hook_blocked)$/.test(innerType) ? 'tool-error' as const : undefined;
    if (inner && kind) {
      const name = String(inner.toolName ?? 'tool');
      const description = typeof inner.description === 'string' ? inner.description.trim().split(/\r?\n/, 1)[0] : '';
      const rawOutput = innerType === 'tool_completed' ? blockText(inner.result) : typeof inner.error === 'string' ? inner.error : '';
      const output = cappedActivityOutput(rawOutput);
      return {
        kind, label: kind === 'tool-start' && description ? `${name}(${visibleSlice(description, 72)})` : name,
        ...(typeof inner.toolCallId === 'string' ? { id: inner.toolCallId } : {}),
        ...(output?.length ? { output } : {}),
      };
    }
  }
  // Pi's own envelope: a flat `{ type: 'toolcall_start', toolName }` --
  // verified from its own docs (packages/coding-agent/docs/json.md), but
  // the docs excerpt available didn't name a paired completion event, so
  // (same as Command Code above) this only ever reports 'tool-start'.
  if (harness.command === 'pi') {
    if (type === 'tool_execution_start') return { kind: 'tool-start', label: String(value.toolName ?? 'tool') };
    if (type === 'tool_execution_end') return {
      kind: value.isError === true || value.error ? 'tool-error' : 'tool-done',
      label: String(value.toolName ?? 'tool'),
    };
    if (type === 'message_update') {
      const event = value.assistantMessageEvent && typeof value.assistantMessageEvent === 'object'
        ? value.assistantMessageEvent as Record<string, unknown> : undefined;
      if (event?.type === 'toolcall_start') return { kind: 'tool-start', label: String(event.toolName ?? 'tool') };
    }
  }
  return undefined;
}

/** The one place that decides what a completed/in-progress tool call or a
 * thinking summary looks like in the persistent activity log -- every
 * harness's parser above feeds this same renderer, so the visual language
 * (glyph, color, wording) never drifts per-vendor. */
/** A code-change tool call (Edit/Write, or any other harness's own naming
 * for the same thing) gets its own color -- magenta -- distinct from a
 * generic tool call's yellow/green, the same way Claude Code's own UI
 * visually separates "a tool ran" from "a file changed" rather than
 * treating every tool call identically. Name-pattern matching (not just
 * `event.diff`'s presence) so this applies even for harnesses where the
 * diff content itself isn't available yet -- Codex's file_change events,
 * for instance, still get the distinct color even without line content. */
export function isCodeChangeLabel(label: string): boolean {
  return /^(edit|write|patch)$/i.test(label) || /file/i.test(label);
}

export function renderActivityLine(event: HarnessActivityEvent): string[] {
  if (event.kind === 'thinking') return [`  ${chalk.cyan('thinking')} ${chalk.dim(event.label)}`];
  // The tool's own label, with nothing prepended to it. A status word in front
  // of every row ("done", "edit", "tool") restated what the row already said by
  // existing -- a finished tool is reported when it finishes -- and pushed the
  // call itself two words to the right on every line. Failure is the one state
  // a label cannot carry on its own, so that, and only that, reads differently.
  // Failure is the exception, and it is a suffix rather than a prefix: colour
  // alone would carry it only on a terminal that has colour, and a piped or
  // NO_COLOR transcript would read a failed call as a successful one.
  const summary = `  ${event.kind === 'tool-error'
    ? `${chalk.red(event.label)} ${chalk.red('failed')}`
    : chalk.dim(event.label)}`;
  if (!event.diff) {
    const output = event.output ?? [];
    const visible = output.slice(0, ACTIVITY_PREVIEW_LINES);
    const hidden = output.length - visible.length;
    return [summary, ...visible.map((line) => `    ${chalk.dim(line)}`),
      ...(hidden > 0 ? [`    ${chalk.dim(`\u2026 ${hidden} more line${hidden === 1 ? '' : 's'}`)}`] : [])];
  }
  // Budget both halves of an edit rather than filling it from the top: a large
  // deletion would otherwise consume the whole preview and hide every added
  // line, which is the half that says what the edit actually did.
  const { removed, added } = event.diff;
  const removedShown = Math.min(removed.length, Math.max(
    Math.floor(ACTIVITY_PREVIEW_LINES / 2), ACTIVITY_PREVIEW_LINES - added.length,
  ));
  const addedShown = Math.min(added.length, ACTIVITY_PREVIEW_LINES - removedShown);
  const hidden = (removed.length - removedShown) + (added.length - addedShown);
  return [
    summary,
    ...removed.slice(0, removedShown).map((line) => `    ${chalk.red(`- ${line}`)}`),
    ...added.slice(0, addedShown).map((line) => `    ${chalk.green(`+ ${line}`)}`),
    ...(hidden > 0 ? [`    ${chalk.dim(`\u2026 ${hidden} more line${hidden === 1 ? '' : 's'}`)}`] : []),
  ];
}

export function nativeActivityPhaseFromValue(harness: AiLocalHarnessDefinition, parsed: unknown): 'generating response' | undefined {
  const value = asRecord(parsed);
  if (!value) return undefined;
  const type = String(value.type ?? '');
  const itemType = String(asRecord(value.item)?.type ?? '');
  if (harness.command === 'antigravity' && value.event === 'step_update') {
    const step = asRecord(value.step_update);
    if (step?.step_type === 'agent_response' && typeof step.text_delta === 'string') return 'generating response';
  }
  if (/assistant|agent_message/.test(itemType) && /started|delta|completed/.test(type)) return 'generating response';
  if (type === 'assistant') {
    // A Claude-shaped assistant record that only carries tool calls (or belongs
    // to a subagent) is not the reply being written.
    if (!CLAUDE_SHAPED.has(harness.command)) return 'generating response';
    if (typeof value.parent_tool_use_id === 'string' && value.parent_tool_use_id) return undefined;
    const content = asRecord(value.message)?.content;
    return !Array.isArray(content) || content.some((part) => asRecord(part)?.type === 'text') ? 'generating response' : undefined;
  }
  if (OPENCODE_SHAPED.has(harness.command) && type === 'text') return 'generating response';
  return undefined;
}

export function nativeActivityPhase(harness: AiLocalHarnessDefinition, lineText: string): 'generating response' | undefined {
  const candidate = lineText.trim();
  if (candidate[0] !== '{') return undefined;
  try {
    return nativeActivityPhaseFromValue(harness, JSON.parse(candidate));
  } catch {
    // fail-open-ok: non-JSON output is ordinary assistant text, not a structured result envelope.
    return undefined;
  }
}

export function compactPath(path: string): string {
  const home = homedir();
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

export function sessionProviderLabel(session: HarnessSession): string {
  if (session.route === 'gateway') return 'ClikDeploy Gateway';
  const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
  return harness?.displayName ?? session.provider ?? 'Not selected';
}

/** The one place that turns an account's nativeProfile into an actual
 * environment object -- every call site used to build `{ [env]: path }`
 * directly, nine of them, which meant nativeProfile.extraEnv (needed only
 * for Antigravity's ADC-based isolation) would have had to be added to all
 * nine individually, with a real risk of missing one and silently falling
 * back to shared, unisolated auth for just that one call path. */
export function nativeProfileEnvironment(
  nativeProfile: AiHarnessAccount['nativeProfile'], platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  if (!nativeProfile) return {};
  return {
    [nativeProfile.env]: nativeProfile.path,
    ...(platform === 'win32' && nativeProfile.env === 'HOME' ? { USERPROFILE: nativeProfile.path } : {}),
    ...nativeProfile.extraEnv,
  };
}
