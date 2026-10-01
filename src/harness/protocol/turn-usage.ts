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
  /** Share of the context window in use, 0-100, for a vendor that reports
   *  only that (Kiro's `contextUsagePercentage`). */
  contextPercent?: number;
  /** What the turn cost in the vendor's own credits, for a vendor that
   *  bills in credits rather than dollars (Kiro's `meteringUsage`). */
  credits?: number;
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
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'totalTokens', 'costUsd', 'credits'] as const) {
    if (latest[key] !== undefined) summed[key] = (carried[key] ?? 0) + latest[key]!;
  }
  for (const key of ['contextWindow', 'contextUsed', 'contextPercent', 'stopReason'] as const) {
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
    usage.cacheReadTokens, usage.cachedReadTokens, usage.cacheReadInputTokens, usage.cacheRead, usage.cached, usage.cachedTokens, cache?.read));
  // `cache_write_input_tokens` is Goose's spelling, `cache_write_tokens` OpenClaw's.
  assign('cacheWrite', finiteNumber(usage.cache_creation_input_tokens, usage.cache_write_input_tokens, usage.cache_write_tokens,
    usage.cacheWriteTokens, usage.cachedWriteTokens, usage.cacheCreationInputTokens, usage.cacheWriteInputTokens, usage.cacheWrite, cache?.write));
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
  // OpenClaw's `--json` document: `{payloads, meta:{agentMeta:{usage, costUsd,
  // contextTokens, promptTokens}}}` -- the run's totals, its price, the
  // model's window and what the last call occupied.
  const agentMeta = asRecord(asRecord(record.meta)?.agentMeta);
  const nested = asRecord(record.usage) ?? asRecord(record.stats) ?? asRecord(record.token_usage)
    ?? asRecord(asRecord(record.part)?.tokens)
    ?? asRecord(envelope?.usage) ?? asRecord(envelope?.stats) ?? asRecord(envelope?.token_usage)
    ?? asRecord(agentMeta?.usage);
  // A terminal record may carry its counts itself rather than in a usage
  // object: Goose ends `run --output-format stream-json` with
  // `{type:"complete", total_tokens, input_tokens, output_tokens,
  // cache_read_input_tokens, cache_write_input_tokens}`. Only a record that
  // declared itself terminal (a `type` that passed the test above) is read
  // this way, so an untyped document's own fields are never taken for counts.
  const usage = nested ?? (type ? record : undefined);
  const result = countsOf(usage);
  const assign = assigner(result);
  assign('costUsd', finiteNumber(record.total_cost_usd, record.cost_usd, record.totalCostUsd, usage?.total_cost_usd, asRecord(record.part)?.cost, agentMeta?.costUsd));
  assign('contextWindow', modelUsageContextWindow(asRecord(record.modelUsage)) ?? finiteNumber(agentMeta?.contextTokens));
  assign('contextUsed', finiteNumber(agentMeta?.promptTokens));
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
    if (record.type === 'assistant') return this.assistant(record);
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

  /** A whole assistant message with its usage (Claude-shaped `assistant`
   * records). Amp's `--stream-json` reports usage ONLY here -- its `result`
   * carries none -- and Qwen's `message_start` carries none, so without this
   * neither said anything until the turn ended, and Amp never did. Claude
   * sends the same message id on its stream events and again here with a
   * snapshot taken mid-message, so counts merge by the larger value: a
   * snapshot can confirm a count, never lower one. A record with no id (Amp)
   * is a message of its own. */
  private assistant(record: JsonRecord): TurnUsage | undefined {
    const message = asRecord(record.message);
    const usage = asRecord(message?.usage);
    if (!usage) return undefined;
    const thread = typeof record.parent_tool_use_id === 'string' ? record.parent_tool_use_id : '';
    const id = typeof message?.id === 'string' && message.id ? message.id : `${thread}#assistant-${this.messages.size}`;
    const reading: TurnUsage = { ...this.messages.get(id) };
    for (const [key, value] of Object.entries(countsOf(usage)) as Array<[keyof TurnUsage, number]>) {
      (reading as Record<string, unknown>)[key] = Math.max(value, (reading[key] as number | undefined) ?? 0);
    }
    const reason = turnStopReason(message?.stop_reason);
    if (reason && reason !== 'completed') reading.stopReason = reason;
    this.messages.set(id, reading);
    this.current.set(thread, id);
    return this.total(thread === '' ? reading : undefined);
  }

  /** One more finished model call, reported whole by a harness that prints
   * it rather than streaming records (Aider's footer). Returns the turn's
   * total so far. */
  add(reading: TurnUsage): TurnUsage {
    this.messages.set(`#${this.messages.size}`, reading);
    return this.total(reading);
  }

  /** Fields that arrive a line after the rest of the latest call's reading
   * (Aider prints its cost on its own line when both cache counts appear).
   * Undefined when there is no call to attach them to. */
  amendLatest(fields: TurnUsage): TurnUsage | undefined {
    const key = [...this.messages.keys()].at(-1);
    if (key === undefined) return undefined;
    const reading = { ...this.messages.get(key), ...fields };
    this.messages.set(key, reading);
    return this.total(reading);
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
  // Grok counts cost in integer ticks, 10^10 to the dollar (its own docs:
  // total_cost_usd 0.01268905 == total_cost_usd_ticks 126890500).
  const ticks = finiteNumber(top.costUsdTicks, top.cost_usd_ticks, top.total_cost_usd_ticks);
  assign('costUsd', finiteNumber(top.totalCostUsd, top.total_cost_usd, top.costUsd, currency === 'USD' ? cost?.amount : undefined,
    ticks === undefined ? undefined : ticks / 1e10));
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

const COUNTED: ReadonlyArray<keyof TurnUsage> = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'totalTokens', 'costUsd'];

/** The SESSION's running totals an ACP update carries, when it carries any.
 *
 * ACP's own `usage_update.cost` is the session's cost so far. Two agents
 * also put the session's token totals in the update's `_meta`: Vibe on its
 * `usage_update` (`{promptTokens, completionTokens, cachedTokens,
 * totalTokens}`), OpenHands on every update under a namespaced key
 * (`{"openhands.dev/metrics": {input_tokens, output_tokens,
 * cache_read_tokens, reasoning_tokens, cost}}`, its conversation's
 * accumulated usage). Read by shape: the `_meta` itself or one object inside
 * it that holds token counts. */
export function acpSessionTotals(update: JsonRecord): TurnUsage | undefined {
  const totals: TurnUsage = {};
  const meta = asRecord(update._meta);
  const candidates = meta ? [meta, ...Object.values(meta).flatMap((value) => asRecord(value) ? [asRecord(value)!] : [])] : [];
  for (const candidate of candidates) {
    const counts = countsOf(candidate);
    if (counts.input === undefined && counts.output === undefined) continue;
    Object.assign(totals, counts);
    const cost = finiteNumber(candidate.cost);
    if (cost !== undefined) totals.costUsd = cost;
    break;
  }
  if (update.sessionUpdate === 'usage_update') {
    const cost = asRecord(update.cost);
    const currency = typeof cost?.currency === 'string' ? cost.currency.toUpperCase() : 'USD';
    const amount = currency === 'USD' ? finiteNumber(cost?.amount) : undefined;
    if (amount !== undefined) totals.costUsd = amount;
  }
  return Object.keys(totals).length ? totals : undefined;
}

/** This turn's share of a running total: what each count grew by since
 * `base`, the total when the turn began. Only fields the total has. */
export function turnShareOf(total: TurnUsage, base: TurnUsage): TurnUsage {
  const share: TurnUsage = {};
  for (const key of COUNTED) {
    const value = total[key];
    if (value !== undefined) (share as Record<string, number>)[key] = Math.max(0, (value as number) - ((base[key] as number | undefined) ?? 0));
  }
  return share;
}
