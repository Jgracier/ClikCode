/** One completed turn, read back out of a vendor's output. */

import type { AiLocalHarnessDefinition } from '../definition.js';
import { parseNativeActivityEventsFromValue } from './activity-events.js';
import { nativeSessionIdsFromValues } from './session-ids.js';
import { CLAUDE_SHAPED, JsonRecord, asRecord, parseJsonDocument, parseJsonLines } from './json-lines.js';
import { NativeTurnUsage, nativeTurnUsage } from './turn-usage.js';

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
    // Plural. Grok Build reports a failed turn as
    // {type:"result",is_error:true,errors:["Internal error: {...402...}"]}
    // with no `error` field at all, so a real reason -- "Grok Build usage
    // balance exhausted" -- was dropped and the turn surfaced only as
    // "returned no assistant text in its structured output".
    if (!toolScoped && Array.isArray(record.errors)) {
      const first = record.errors.find((item): item is string => typeof item === 'string' && item.trim().length > 0);
      if (first) errorMessage = first.trim();
    }
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
  const text = claudeText || gooseStreamText.trim() || messages[messages.length - 1]?.trim() || errorMessage;
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
    // Say what the harness said. "No assistant text" describes the symptom;
    // the reason it gave -- a balance, a quota, an expired key -- is the only
    // part anyone can act on, and it is right there in the stream.
    throw new Error(errorMessage
      ? `${harness.displayName}: ${errorMessage}`
      : `${harness.displayName} returned no assistant text in its structured output`);
  }
  // A vendor that answers "you are out of usage" while reporting SUCCESS.
  // Augment's auggie does this: is_error false, subtype "success", exit 0,
  // and the upgrade notice sitting where the answer belongs. Left alone, the
  // notice became the assistant's reply in the transcript, the account stayed
  // marked available, and failover never fired -- verified live on a real
  // exhausted account.
  //
  // Only phrases the harness itself declares are matched, so this cannot
  // mistake a model TALKING about running out of usage for an account that
  // has. errorKind is set to the same vocabulary the rest of the pipeline
  // already understands, so classifyAccountFailure resolves it to
  // 'quota-exhausted' and the existing failover and usage-learning paths
  // handle it with no new branching anywhere.
  const quotaSignal = harness.turn.quotaSignals?.find((phrase) => text.includes(phrase));
  if (quotaSignal) {
    throw Object.assign(
      new Error(`${harness.displayName}: ${text.replace(/\s+/g, ' ').trim()}`),
      { errorKind: 'quota_exhausted', isResultError: true },
    );
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
