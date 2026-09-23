/** Token counts and the self-report a harness makes about its own turn. */

import type { AiLocalHarnessDefinition } from '../definition.js';
import { asRecord, parseJsonDocument, parseJsonLines } from './json-lines.js';

export interface NativeTurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  totalTokens?: number;
  /** Reasoning tokens where the vendor counts them separately. Billed and
   *  quota-consuming, so they belong in a cost figure. */
  thinkingTokens?: number;
  totalCostUsd?: number;
  durationMs?: number;
  numTurns?: number;
}

const finiteNumber = (...candidates: unknown[]): number | undefined =>
  candidates.find((candidate): candidate is number => typeof candidate === 'number' && Number.isFinite(candidate));

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

function nativeSelfReportFromValue(value: unknown): NativeSelfReport | undefined {
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
      const hint = typeof item?.input?.valueOf === 'function' && typeof (asRecord(item.input)?.hint) === 'string'
        ? String(asRecord(item.input)?.hint) : undefined;
      return [{ name, ...(description ? { description } : {}), ...(hint ? { hint } : {}) }];
    });
    if (named.length) report.commands = named;
  }
  return Object.keys(report).length ? report : undefined;
}

/** Read one stream line for what the harness says about itself. Self-gated, so
 * ordinary output lines are not re-parsed as JSON. */
export function nativeSelfReportFromLine(lineText: string): NativeSelfReport | undefined {
  if (!/"(?:model|model_id|modelId|permissionMode|permission_mode|approvalMode|slash_commands|slashCommands|availableCommands|available_commands|commands)"/.test(lineText)) return undefined;
  try {
    return nativeSelfReportFromValue(JSON.parse(lineText));
  } catch {
    // fail-open-ok: one unparseable line on a decoration path; the turn's own
    // output is read elsewhere and is unaffected.
    return undefined;
  }
}

/** Usage reported by one record, if it is a usage-bearing terminal record. */
export function nativeUsageFromValue(value: unknown): NativeTurnUsage | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  // `type` is the common spelling; `event` is antigravity's and several
  // generic-json harnesses'. Reading only `type` meant those were never even
  // considered as terminal records.
  const type = String(record.type ?? record.event ?? '');
  // Only terminal/summary records: per-message usage on an `assistant` event is
  // a partial count that the final record supersedes.
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
  const cache = asRecord(usage?.cache);
  const result: NativeTurnUsage = {};
  const assign = <K extends keyof NativeTurnUsage>(key: K, number: number | undefined): void => { if (number !== undefined) result[key] = number; };
  assign('inputTokens', finiteNumber(usage?.input_tokens, usage?.inputTokens, usage?.prompt_tokens, usage?.input));
  assign('outputTokens', finiteNumber(usage?.output_tokens, usage?.outputTokens, usage?.completion_tokens, usage?.output));
  assign('cacheReadTokens', finiteNumber(usage?.cache_read_input_tokens, usage?.cached_input_tokens, usage?.cache_read_tokens, usage?.cacheReadTokens, usage?.cached, cache?.read));
  assign('cacheCreationTokens', finiteNumber(usage?.cache_creation_input_tokens, usage?.cacheWriteTokens, cache?.write));
  assign('totalTokens', finiteNumber(usage?.total_tokens, usage?.totalTokens, usage?.total));
  // Reasoning tokens are billed and counted by several vendors (antigravity's
  // `thinking_tokens`, others' `reasoning_tokens`) and were being dropped.
  assign('thinkingTokens', finiteNumber(usage?.thinking_tokens, usage?.thinkingTokens, usage?.reasoning_tokens));
  assign('totalCostUsd', finiteNumber(record.total_cost_usd, record.cost_usd, record.totalCostUsd, usage?.total_cost_usd, asRecord(record.part)?.cost));
  assign('durationMs', finiteNumber(record.duration_ms, record.durationMs,
    envelope?.duration_ms, envelope?.durationMs,
    // Seconds, not ms: antigravity publishes `duration_seconds`.
    ...(finiteNumber(record.duration_seconds, envelope?.duration_seconds) !== undefined
      ? [finiteNumber(record.duration_seconds, envelope?.duration_seconds)! * 1000] : [])));
  assign('numTurns', finiteNumber(record.num_turns, record.numTurns, envelope?.num_turns, envelope?.numTurns));
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
