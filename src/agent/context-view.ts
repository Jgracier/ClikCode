/** A bounded view of an append-only conversation. No summarising model call,
 * transcript rewrite or alteration of user instructions is involved. */
import type { ConversationItem, ToolSpec } from './model-client.js';
import { CORE_TOOLS } from './on-demand-tools.js';

export const UNKNOWN_CONTEXT_WINDOW = 32_768;
/** The estimate is learned from what the provider counts, in both directions; it never drops below half the cautious figure. */
export const MIN_CONTEXT_SCALE = 0.5;
/** Output a request may ask for when the model states no limit of its own. */
const DEFAULT_OUTPUT_CEILING = 16_384;

export class ContextFitError extends Error {
  readonly code = 'CONTEXT_BUDGET_EXCEEDED';
  readonly kind = 'other';
  constructor(readonly inputTokens: number, readonly contextWindow: number) {
    super(`ClikCode's instructions, tools and your message need about ${inputTokens.toLocaleString()} tokens (counting room for a reply), but this model's context window is ${contextWindow.toLocaleString()}. A deployment of this model with a larger window (32,000 or more) fixes this, or pick another model. Your conversation is saved and nothing was cut. The counts are estimates.`);
  }
}

/** A conservative fallback, not a tokenizer claim. Full UTF-8 text and schemas
 * count; opaque image data is charged separately instead of as base64 text. */
export function estimateRequestTokens(system: string, items: readonly ConversationItem[], tools: readonly ToolSpec[]): number {
  let bytes = Buffer.byteLength(system) + Buffer.byteLength(JSON.stringify(tools));
  let images = 0;
  for (const item of items) {
    if (item.type === 'text' || item.type === 'tool_result') {
      const { images: pictures, ...text } = item;
      bytes += Buffer.byteLength(JSON.stringify(text));
      images += pictures?.length ?? 0;
    } else bytes += Buffer.byteLength(JSON.stringify(item));
  }
  return Math.ceil(bytes / 3) + items.length * 8 + tools.length * 8 + images * 1_600 + 32;
}

export function responseReserve(window: number, maximum?: number): number {
  return Math.min(maximum ?? 16_384, Math.max(128, Math.floor(window / 5)));
}

/**
 * The estimate's multiplier after a step: the provider's own count of the prompt against what was estimated for it, in
 * both directions, with a tenth of margin kept and never below MIN_CONTEXT_SCALE. `estimate` is the SCALED figure the
 * request was fitted with, so `current * reported / estimate` is reported over the unscaled estimate. Pure.
 */
export function learnScale(current: number, reportedPromptTokens: number | undefined, estimate: number): number {
  if (!reportedPromptTokens || !(estimate > 0)) return current;
  return Math.max(MIN_CONTEXT_SCALE, (current * reportedPromptTokens / estimate) * 1.1);
}

/**
 * `max_tokens` for a request: what is left of the window after the request itself, within the model's own output limit.
 * Not a fixed share of the window, which cut a long answer short on a request that left far more room than that.
 */
export function outputRoom(window: number, requestTokens: number, ceiling?: number): number {
  const left = window - requestTokens - Math.max(128, Math.ceil(window * 0.05));
  return Math.max(128, Math.min(ceiling ?? DEFAULT_OUTPUT_CEILING, left));
}

function excerpt(text: string, limit: number, reference: string): string {
  if (text.length <= limit) return text;
  const end = Math.floor(limit / 3);
  return `${text.slice(0, limit - end)}\n[Excerpt; read_context ${reference} for the complete text.]\n${text.slice(-end)}`;
}

/** Notices the harness writes in the user's voice. Marked `source: 'harness'` from now on; a transcript written before that
 * (a conversation outlives the build that began it) is recognised by the form every one of them has. */
const HARNESS_NOTE = /^\[(?:background (?:agent|shell|task)\b|harness\]|Stop hook\]|SubagentStop hook\])/;
export function isHarnessNote(item: ConversationItem): boolean {
  return item.type === 'text' && item.role === 'user' && (item.source === 'harness' || HARNESS_NOTE.test(item.text));
}
/** What the user actually asked: their own messages, never the harness's. */
const isUserRequest = (item: ConversationItem): boolean => item.type === 'text' && item.role === 'user' && !isHarnessNote(item);

interface Group { start: number; items: ConversationItem[]; required: boolean }

/** A model step's calls and results travel together, including its signed
 * reasoning. A lone old result can never be paired with a different call. */
function groups(items: readonly ConversationItem[]): Group[] {
  const result: Group[] = [];
  let latestUser = items.length - 1;
  while (latestUser >= 0) {
    const item = items[latestUser]!;
    if (isUserRequest(item)) break;
    latestUser--;
  }
  for (const [index, item] of items.entries()) {
    const boundary = item.type === 'summary' || (item.type === 'text' && item.role === 'user');
    const required = index === latestUser;
    let group = result.at(-1);
    const afterResult = group?.items.some((entry) => entry.type === 'tool_result');
    if (!group || boundary || group.required || (group.items[0]?.type === 'text' && group.items[0].role === 'user') || (afterResult && item.type !== 'tool_result')) {
      group = { start: index, items: [], required };
      result.push(group);
    }
    group.items.push(item);
  }
  return result;
}

/**
 * `args` with every long string cut to `limit` (the excerpt says how to read the rest), keys and short values kept, so a call
 * stays a valid call. A model that launched five agents with long prompts left ~4k tokens in ONE kept step, which no amount
 * of shrinking text and results could remove: the "minimal" view was not minimal.
 */
export function shrinkArgs(args: Record<string, unknown>, limit: number, reference: string): Record<string, unknown> {
  const cut = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') return value.length > limit ? excerpt(value, limit, reference) : value;
    if (depth >= 3) return value;
    if (Array.isArray(value)) {
      const kept = value.slice(0, 8).map((entry) => cut(entry, depth + 1));
      return value.length > 8 ? [...kept, `[... ${value.length - 8} more; read_context ${reference} for all of them.]`] : kept;
    }
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, cut(entry, depth + 1)]));
    return value;
  };
  return cut(args, 0) as Record<string, unknown>;
}

function textOf(items: readonly ConversationItem[]): string {
  return items.map((item) => item.type === 'text' || item.type === 'summary' || item.type === 'reasoning' ? item.text : item.type === 'tool_result' ? item.output : JSON.stringify(item.args)).join('\n');
}

export interface ContextView {
  items: readonly ConversationItem[];
  tools: readonly ToolSpec[];
  estimatedTokens: number;
  omittedGroups: number;
}

export function fitContext(input: {
  system: string; items: readonly ConversationItem[]; tools: readonly ToolSpec[];
  window?: number; outputReserve?: number; scale?: number; maxItems?: number; requiredTools?: readonly string[];
}): ContextView {
  // A window nobody reported is a guess, and the guess is never a reason to refuse: the server knows its own limit.
  const windowKnown = Boolean(input.window && input.window > 0);
  const window = windowKnown ? input.window! : UNKNOWN_CONTEXT_WINDOW;
  const reserve = input.outputReserve ?? responseReserve(window);
  const budget = Math.max(0, window - reserve - Math.max(128, Math.ceil(window * 0.05)));
  const scale = Math.max(MIN_CONTEXT_SCALE, input.scale ?? 1);
  const cost = (items: readonly ConversationItem[], tools: readonly ToolSpec[]) => Math.ceil(estimateRequestTokens(input.system, items, tools) * scale);
  const maxItems = input.maxItems ?? 1_500;
  const initial = cost(input.items, input.tools);
  if (initial <= budget && input.items.length <= maxItems) return { items: input.items, tools: input.tools, estimatedTokens: initial, omittedGroups: 0 };

  const all = groups(input.items);
  const selected = new Set(all.filter((group) => group.required));
  const optional = all.filter((group) => !group.required);
  const last = optional.at(-1);
  const taskStart = all.find((group) => group.required)?.start ?? -1;
  const recent = [...optional].reverse();
  // The immediate result is the evidence for the next action, even if an
  // older assistant narration would have scored higher on keyword overlap.
  if (last && last.start > taskStart) selected.add(last);
  const latestEvidence = recent.find((group) => group.start > taskStart && group.items.some((item) => item.type === 'tool_result'));
  if (latestEvidence) selected.add(latestEvidence);
  // Continuation instructions must retain the reply they refer to, even
  // when older user requests would otherwise outrank its unfinished tail.
  const latestReply = recent.find((group) => group.start > taskStart && group.items.some((item) => item.type === 'text' && item.role === 'assistant'));
  if (latestReply) selected.add(latestReply);
  const query = textOf(input.items.filter(isUserRequest).slice(-2)).toLowerCase();
  const words = new Set((query.match(/[\p{L}\p{N}_./-]{3,}/gu) ?? []).slice(-128));
  const ranked = optional.filter((group) => !selected.has(group)).map((group, index) => {
    const text = textOf(group.items).toLowerCase();
    let relevance = 0;
    for (const word of words) if (text.includes(word)) relevance++;
    return { group, score: (group.items.some(isUserRequest) ? 100 : 0) + relevance * 2 + index / Math.max(1, optional.length) };
  }).sort((a, b) => b.score - a.score);

  const prepare = (group: Group, limit: number) => group.items.map((item, offset): ConversationItem => {
    if (group.required) return item;
    const reference = item.type === 'tool_result' ? `source=tool id=${JSON.stringify(item.id)}` : `source=history id="item:${group.start + offset}"`;
    if (item.type === 'tool_result') return { ...item, output: excerpt(item.output, limit, reference) };
    if (item.type === 'text') return { ...item, text: excerpt(item.text, limit, reference) };
    if (item.type === 'tool_call') return { ...item, args: shrinkArgs(item.args, limit, reference) };
    return item; // Signed reasoning is preserved verbatim or omitted with its whole step.
  });
  const materialize = (limit: number) => {
    const kept = all.filter((group) => selected.has(group));
    const items = kept.flatMap((group) => prepare(group, limit));
    const referenced = new Set(items.flatMap((item) => item.type === 'tool_call' ? [item.name] : []));
    // Retain every declared tool used by the kept history. Unused, previously
    // loaded specialists can be rediscovered through their loader.
    const essential = new Set([...CORE_TOOLS, 'load_tools', 'load_mcp_tools', ...(input.requiredTools ?? [])]);
    // A just-requested specialist must be offered on the next step even
    // when its loader pushed the request over budget.
    for (const item of last?.items ?? []) {
      if (item.type === 'tool_call' && (item.name === 'load_tools' || item.name === 'load_mcp_tools') && Array.isArray(item.args.tools)) {
        for (const name of item.args.tools) if (typeof name === 'string') essential.add(name);
      }
    }
    const canReload = input.tools.some((tool) => tool.name === 'load_tools' || tool.name === 'load_mcp_tools');
    const tools = input.tools.filter((tool) => !canReload || referenced.has(tool.name) || essential.has(tool.name));
    const omitted = all.length - kept.length;
    const note: ConversationItem = { type: 'text', role: 'assistant', text: `[Working context: ${omitted} older work group(s) are outside this view. The current user request remains verbatim. Earlier requests and evidence remain in the retained history. Use read_context to search the complete retained history and tool results before relying on missing details. Excerpts are not complete evidence.]` };
    return { items: omitted ? [note, ...items] : items, tools, omittedGroups: omitted };
  };

  let limit = Math.max(256, Math.min(4_096, Math.floor(window / (4 * scale))));
  let view = materialize(limit);
  while ((cost(view.items, view.tools) > budget || view.items.length > maxItems) && limit > 256) {
    limit = Math.max(256, Math.floor(limit / 2));
    view = materialize(limit);
  }
  // Still over at the smallest excerpts: let go of the kept steps one at a time, least useful first (the assistant's own
  // narration, then the latest evidence, then the latest step). All of it stays retrievable with read_context. Only when
  // the request, the instructions and the tools alone do not fit is the turn refused.
  for (const group of [latestReply, latestEvidence, last]) {
    if (!(cost(view.items, view.tools) > budget || view.items.length > maxItems)) break;
    if (!group || group.required || !selected.has(group)) continue;
    selected.delete(group);
    view = materialize(limit);
  }
  if (windowKnown && (cost(view.items, view.tools) > budget || view.items.length > maxItems)) throw new ContextFitError(cost(view.items, view.tools) + reserve, window);
  // Incremental costs avoid serializing the whole selected history for
  // every candidate. The final request is materialized only once.
  let used = cost(view.items, view.tools);
  let count = view.items.length;
  const declared = new Set(view.tools.map((tool) => tool.name));
  const empty = estimateRequestTokens('', [], []);
  for (const { group } of ranked) {
    const items = prepare(group, limit);
    const referenced = new Set(items.flatMap((item) => item.type === 'tool_call' ? [item.name] : []));
    const addedTools = input.tools.filter((tool) => referenced.has(tool.name) && !declared.has(tool.name));
    // Four tokens cover rounding and the schema-array separators, even at
    // a different tokenizer calibration scale.
    const extra = Math.ceil((estimateRequestTokens('', items, addedTools) - empty + 4) * scale);
    if (count + items.length <= maxItems && used + extra <= budget) {
      selected.add(group);
      used += extra;
      count += items.length;
      for (const tool of addedTools) declared.add(tool.name);
    }
  }
  view = materialize(limit);
  return { ...view, estimatedTokens: cost(view.items, view.tools) };
}
