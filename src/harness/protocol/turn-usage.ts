/** Token usage, cost and stop reason for one turn -- one shape for every
 * harness and transport -- and the self-report a harness makes about itself. */

import type { AiLocalHarnessDefinition } from '../definition.js';
import { asRecord, parseJsonDocument, parseJsonLines, type JsonRecord } from './json-lines.js';

/** Why a turn ended, in ClikCode's words. Only the reasons a user has to be
 * told about are distinguished; a vendor reason not listed here is dropped
 * rather than guessed at. */
export type TurnStopReason = 'completed' | 'max-tokens' | 'max-turns' | 'refusal' | 'cancelled' | 'failed';

/** What a turn cost, as far as its harness says. Every field is optional: a
 * count the vendor did not publish stays absent, never an invented zero.
 *
 * The one type every transport reports through (`onUsage`), the worker sends
 * to its clients and the status line reads. Persisted records (invocations)
 * keep their own older field names. */
export interface TurnUsage {
  /** Input tokens as the vendor counts them: Claude excludes cache reads,
   *  Codex and OpenAI-shaped APIs include them. */
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Reasoning tokens where the vendor counts them separately. Billed and
   *  quota-consuming, so they belong in a cost figure. */
  reasoning?: number;
  totalTokens?: number;
  costUsd?: number;
  /** The model's context window. */
  contextWindow?: number;
  /** Tokens the conversation occupied at the latest model call. */
  contextUsed?: number;
  stopReason?: TurnStopReason;
}

const finiteNumber = (...candidates: unknown[]): number | undefined =>
  candidates.find((candidate): candidate is number => typeof candidate === 'number' && Number.isFinite(candidate));

const STOP_REASONS: Readonly<Record<string, TurnStopReason>> = {
  end_turn: 'completed', stop: 'completed', stop_sequence: 'completed', completed: 'completed', success: 'completed',
  max_tokens: 'max-tokens', length: 'max-tokens', max_output_tokens: 'max-tokens',
  max_turns: 'max-turns', error_max_turns: 'max-turns', max_turn_requests: 'max-turns', 'max-steps': 'max-turns',
  refusal: 'refusal', content_filter: 'refusal', 'content-filter': 'refusal',
  cancelled: 'cancelled', interrupted: 'cancelled',
  failed: 'failed',
};

/** A vendor's stop reason (Claude's `stop_reason`/`subtype`, ACP's
 * `stopReason`, Codex's turn status, an OpenAI `finish_reason`) in ClikCode's
 * words, or undefined for one it does not need to distinguish. */
export function turnStopReason(raw: unknown): TurnStopReason | undefined {
  return typeof raw === 'string' ? STOP_REASONS[raw.replace(/-/g, '_')] ?? STOP_REASONS[raw] : undefined;
}

/** What to tell the user about a turn that did not end normally, where the
 * answer on screen is not the whole answer. */
export function stopReasonNotice(reason: TurnStopReason | undefined): string | undefined {
  if (reason === 'max-tokens') return 'The answer was cut off: the model reached its output limit.';
  if (reason === 'max-turns') return 'The turn stopped at its step limit before the work was finished.';
  if (reason === 'refusal') return 'The model declined to continue this answer.';
  return undefined;
}

/** Sum two readings of separate work (the attempts of one continued turn).
 * Counts add; a capacity, a position or a reason is a reading of the latest
 * state, so the later one wins. A field absent from both stays absent. */
export function addTurnUsage(carried: TurnUsage | undefined, latest: TurnUsage | undefined): TurnUsage | undefined {
  if (!carried) return latest;
  if (!latest) return carried;
  const summed: TurnUsage = { ...carried };
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'totalTokens', 'costUsd'] as const) {
    if (latest[key] !== undefined) summed[key] = (carried[key] ?? 0) + latest[key]!;
  }
  for (const key of ['contextWindow', 'contextUsed', 'stopReason'] as const) {
    if (latest[key] !== undefined) (summed as Record<string, unknown>)[key] = latest[key];
  }
  return summed;
}

function assigner(result: TurnUsage) {
  return <K extends keyof TurnUsage>(key: K, value: TurnUsage[K] | undefined): void => { if (value !== undefined) result[key] = value; };
}

/** The largest context window any model of a Claude `modelUsage` table
 * reports -- the main model's, since a helper model is never the larger. */
function modelUsageContextWindow(modelUsage: JsonRecord | undefined): number | undefined {
  const windows = Object.values(modelUsage ?? {}).flatMap((entry) => {
    const window = finiteNumber(asRecord(entry)?.contextWindow);
    return window ? [window] : [];
  });
  return windows.length ? Math.max(...windows) : undefined;
}

/** Token counts from one usage object, in any of the spellings vendors use.
 * `input_tokens` (Anthropic), `inputTokens` (Cursor, Codex, ACP),
 * `prompt_tokens` (OpenAI), `input` (opencode, Pi); caches likewise. */
export function countsOf(usage: JsonRecord | undefined): TurnUsage {
  const result: TurnUsage = {};
  if (!usage) return result;
  const assign = assigner(result);
  const cache = asRecord(usage.cache);
  const outputDetails = asRecord(usage.output_tokens_details) ?? asRecord(usage.completion_tokens_details);
  assign('input', finiteNumber(usage.input_tokens, usage.inputTokens, usage.prompt_tokens, usage.promptTokens, usage.input));
  assign('output', finiteNumber(usage.output_tokens, usage.outputTokens, usage.completion_tokens, usage.completionTokens, usage.output));
  assign('cacheRead', finiteNumber(usage.cache_read_input_tokens, usage.cached_input_tokens, usage.cachedInputTokens, usage.cache_read_tokens,
    usage.cacheReadTokens, usage.cachedReadTokens, usage.cacheReadInputTokens, usage.cacheRead, usage.cached, cache?.read));
  assign('cacheWrite', finiteNumber(usage.cache_creation_input_tokens, usage.cacheWriteTokens, usage.cachedWriteTokens,
    usage.cacheCreationInputTokens, usage.cacheWriteInputTokens, usage.cacheWrite, cache?.write));
  assign('totalTokens', finiteNumber(usage.total_tokens, usage.totalTokens, usage.total));
  // Reasoning tokens are billed and counted by several vendors (antigravity's
  // `thinking_tokens`, OpenAI's `reasoning_tokens`, Codex's
  // `reasoningOutputTokens`, ACP's `thoughtTokens`, Claude's nested
  // `output_tokens_details.thinking_tokens`).
  assign('reasoning', finiteNumber(usage.thinking_tokens, usage.thinkingTokens, usage.reasoning_tokens, usage.reasoningTokens,
    usage.reasoningOutputTokens, usage.reasoning_output_tokens, usage.thoughtTokens, usage.reasoning,
    outputDetails?.thinking_tokens, outputDetails?.reasoning_tokens));
  return result;
}

/** Usage reported by one record, if it is a usage-bearing terminal record. */
export function nativeUsageFromValue(value: unknown): TurnUsage | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  // `type` is the common spelling; `event` is antigravity's and several
  // generic-json harnesses'. Reading only `type` meant those were never even
  // considered as terminal records.
  const type = String(record.type ?? record.event ?? '');
  // Only terminal/summary records here: per-message usage mid-turn is read by
  // streamUsage below, where it can be summed per message instead of being
  // mistaken for the turn's total.
  if (type && !/(?:^|[._-])(?:result|complete|completed|finish|finished|done|usage|stats?)(?:$|[._-])/i.test(type)) return undefined;
  // Usage sits beside the terminal marker for some vendors and one level
  // INSIDE the payload for others: antigravity emits
  // `{event:"result", result:{..., usage:{...}}}`, so reading only the top
  // level found nothing and every antigravity turn recorded zero tokens.
  // The nested envelopes are named, not guessed, so this cannot wander into
  // an unrelated object that happens to hold a `usage` key.
  const envelope = asRecord(record.result) ?? asRecord(record.turn) ?? asRecord(record.data)
    ?? asRecord(record.response) ?? asRecord(record.summary);
  const usage = asRecord(record.usage) ?? asRecord(record.stats) ?? asRecord(record.token_usage)
    ?? asRecord(asRecord(record.part)?.tokens)
    ?? asRecord(envelope?.usage) ?? asRecord(envelope?.stats) ?? asRecord(envelope?.token_usage);
  const result = countsOf(usage);
  const assign = assigner(result);
  assign('costUsd', finiteNumber(record.total_cost_usd, record.cost_usd, record.totalCostUsd, usage?.total_cost_usd, asRecord(record.part)?.cost));
  assign('contextWindow', modelUsageContextWindow(asRecord(record.modelUsage)));
  // Claude: a turn cut short says so in `subtype` (error_max_turns) or in the
  // last message's `stop_reason` (max_tokens, refusal); the reason is
  // meaningful only beside a terminal record, never inside a tool payload.
  if (/(?:^|[._-])result(?:$|[._-])/i.test(type)) {
    assign('stopReason', turnStopReason(record.subtype) === 'max-turns' ? 'max-turns'
      : turnStopReason(record.stop_reason) ?? turnStopReason(record.terminal_reason) ?? turnStopReason(record.stopReason));
  }
  // A stop reason alone is not usage: only a record carrying counts or a
  // price is one.
  const { stopReason: _reason, ...counted } = result;
  return Object.keys(counted).length ? result : undefined;
}

/** Live usage from the per-message records of a stream, summed per message.
 *
 * Every model call of a turn is one message. On Claude's stream-json,
 * `message_start` carries its input and cache counts and `message_delta` its
 * running output count (and, at the end, its stop reason); Pi's
 * `message_end` carries a finished message's whole usage and cost. A turn
 * that calls a tool is several messages, so the turn's usage is the SUM over
 * messages -- each message's latest reading, not the latest reading overall.
 * A terminal record, where the harness writes one, then reports the vendor's
 * own totals and cost, which win field by field. */
export class StreamUsageTally {
  private readonly messages = new Map<string, TurnUsage>();
  /** The message each thread (main, or a sub-agent's parent_tool_use_id) is on. */
  private readonly current = new Map<string, string>();

  /** The turn's usage so far after this record, or undefined when the record
   * carries none. */
  note(record: JsonRecord): TurnUsage | undefined {
    if (record.type === 'message_end') return this.finished(asRecord(record.message));
    if (record.type !== 'stream_event') return undefined;
    const event = asRecord(record.event);
    const thread = typeof record.parent_tool_use_id === 'string' ? record.parent_tool_use_id : '';
    let id: string | undefined;
    let usage: JsonRecord | undefined;
    let stop: unknown;
    if (event?.type === 'message_start') {
      const message = asRecord(event.message);
      id = typeof message?.id === 'string' ? message.id : `${thread}#${this.messages.size}`;
      this.current.set(thread, id);
      usage = asRecord(message?.usage);
    } else if (event?.type === 'message_delta') {
      id = this.current.get(thread);
      usage = asRecord(event.usage);
      stop = asRecord(event.delta)?.stop_reason;
    }
    if (!id || (!usage && stop === undefined)) return undefined;
    const reading = { ...this.messages.get(id), ...countsOf(usage) };
    const reason = turnStopReason(stop);
    // Only a reason that cuts an answer short is worth carrying from a single
    // message; `tool_use` and `end_turn` say nothing about the turn.
    if (reason && reason !== 'completed') reading.stopReason = reason;
    this.messages.set(id, reading);
    return this.total(thread === '' ? reading : undefined);
  }

  /** Pi: one finished assistant message, usage and cost complete. */
  private finished(message: JsonRecord | undefined): TurnUsage | undefined {
    const usage = asRecord(message?.usage);
    if (message?.role !== 'assistant' || !usage) return undefined;
    const reading = countsOf(usage);
    const cost = finiteNumber(asRecord(usage.cost)?.total);
    if (cost !== undefined) reading.costUsd = cost;
    const reason = turnStopReason(message.stopReason);
    if (reason && reason !== 'completed') reading.stopReason = reason;
    this.messages.set(`#${this.messages.size}`, reading);
    return this.total(reading);
  }

  private total(main: TurnUsage | undefined): TurnUsage {
    let sum: TurnUsage | undefined;
    for (const reading of this.messages.values()) {
      const { stopReason: _reason, ...counts } = reading;
      sum = addTurnUsage(sum, counts);
    }
    const result: TurnUsage = { ...sum };
    // The context is the main thread's: its latest call read everything
    // before it and wrote its answer on top.
    if (main) {
      const used = main.totalTokens ?? (main.input ?? 0) + (main.cacheRead ?? 0) + (main.cacheWrite ?? 0) + (main.output ?? 0);
      if (used > 0) result.contextUsed = used;
      if (main.stopReason) result.stopReason = main.stopReason;
    }
    return result;
  }
}

/** One shape for a usage payload a transport received as published: ACP's
 * prompt response `usage` (`{inputTokens, outputTokens, thoughtTokens,
 * cachedReadTokens, …}`) and its `usage_update` (`{used, size, cost}` -- the
 * context occupied, the window, and the session's cost so far). Codex's
 * thread-level readings are turned into a turn's by its own transport
 * (codexTurnUsage), which alone knows where the turn began. */
export function normalizeTurnUsage(raw: unknown): TurnUsage | undefined {
  const top = asRecord(raw);
  if (!top) return undefined;
  const result = countsOf(top);
  const assign = assigner(result);
  const cost = asRecord(top.cost);
  const currency = typeof cost?.currency === 'string' ? cost.currency.toUpperCase() : 'USD';
  assign('costUsd', finiteNumber(top.totalCostUsd, top.total_cost_usd, top.costUsd, currency === 'USD' ? cost?.amount : undefined));
  assign('contextWindow', finiteNumber(top.modelContextWindow, top.model_context_window, top.contextWindow, top.size));
  assign('contextUsed', finiteNumber(top.used, top.contextUsed));
  return Object.keys(result).length ? result : undefined;
}

/** Token usage and cost from the turn's final usage-bearing record (Claude's
 * `result`: usage.*_tokens + total_cost_usd; Codex's `turn.completed`; ...).
 * Accepts raw stdout or already-parsed events. */
export function nativeTurnUsage(
  harness: AiLocalHarnessDefinition, output: string | readonly unknown[],
): TurnUsage | undefined {
  const values = typeof output === 'string'
    ? (harness.turn?.output === 'json' ? parseJsonDocument(output) : harness.turn?.output === 'text' ? [] : parseJsonLines(output).values)
    : output;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const usage = nativeUsageFromValue(values[index]);
    if (usage) return usage;
  }
  return undefined;
}

/** What a harness says about itself on its own stream.
 *
 * Every vendor opens a turn by announcing what it is about to do it with --
 * the model it resolved, the permission mode it applied, the commands it
 * offers -- and ClikCode was displaying what it had ASKED for instead. A
 * session set to `automatic` showed "automatic"; a vendor that substituted a
 * model said so and was not heard.
 *
 * Read by shape, not by vendor: an opening record (`system`/init,
 * `session_configured`, `session.started`, …) carrying any of these fields.
 * Per-message records are ignored -- `assistant` events carry a `model` too,
 * and echoing that every frame would fight the session's own settings. */
export interface NativeSelfReport {
  model?: string;
  permissionMode?: string;
  commands?: Array<{ name: string; description?: string; hint?: string }>;
}

const OPENING_RECORD = /(?:^|[._-])(?:init|initialized|configured|started|ready|system|session)(?:$|[._-])/i;

/** Read one already-parsed stream record for what the harness says about
 * itself. The type is checked first, so an ordinary record costs one test. */
export function nativeSelfReportFromValue(value: unknown): NativeSelfReport | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const type = String(record.type ?? record.method ?? '');
  const subtype = String(record.subtype ?? '');
  if (!OPENING_RECORD.test(type) && !OPENING_RECORD.test(subtype)) return undefined;
  const source = asRecord(record.session) ?? asRecord(record.params) ?? record;
  const report: NativeSelfReport = {};
  const model = source.model ?? source.model_id ?? source.modelId;
  if (typeof model === 'string' && model.trim()) report.model = model.trim();
  const mode = source.permissionMode ?? source.permission_mode ?? source.approvalMode ?? source.approval_mode;
  if (typeof mode === 'string' && mode.trim()) report.permissionMode = mode.trim();
  const commands = source.slash_commands ?? source.slashCommands ?? source.availableCommands ?? source.available_commands ?? source.commands;
  if (Array.isArray(commands)) {
    const named = commands.flatMap((entry) => {
      if (typeof entry === 'string') return entry.trim() ? [{ name: entry.trim().replace(/^\//, '') }] : [];
      const item = asRecord(entry);
      const name = typeof item?.name === 'string' ? item.name.trim().replace(/^\//, '') : undefined;
      if (!name) return [];
      const description = typeof item?.description === 'string' ? item.description : undefined;
      const hint = asRecord(item?.input)?.hint;
      return [{ name, ...(description ? { description } : {}), ...(typeof hint === 'string' ? { hint } : {}) }];
    });
    if (named.length) report.commands = named;
  }
  return Object.keys(report).length ? report : undefined;
}
