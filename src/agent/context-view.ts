/** A bounded view of an append-only conversation. No summarising model call,
 * transcript rewrite or alteration of user instructions is involved. */
import type { ConversationItem, ToolSpec } from './model-client.js';
import { CORE_TOOLS } from './on-demand-tools.js';

export const UNKNOWN_CONTEXT_WINDOW = 32_768;

export class ContextFitError extends Error {
  readonly code = 'CONTEXT_BUDGET_EXCEEDED';
  readonly kind = 'other';
  constructor(readonly inputTokens: number, readonly contextWindow: number) {
    super(`The current instructions, user requests and required tools need about ${inputTokens.toLocaleString()} input tokens, beyond this model's ${contextWindow.toLocaleString()}-token context budget. The full conversation is saved. Choose a larger context or start a new task; no user instructions were silently removed.`);
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
  return Math.min(maximum ?? 4_096, Math.max(128, Math.floor(window / 5)));
}

function excerpt(text: string, limit: number, reference: string): string {
  if (text.length <= limit) return text;
  const end = Math.floor(limit / 3);
  return `${text.slice(0, limit - end)}\n[Excerpt; read_context ${reference} for the complete text.]\n${text.slice(-end)}`;
}

interface Group { start: number; items: ConversationItem[]; required: boolean }

/** A model step's calls and results travel together, including its signed
 * reasoning. A lone old result can never be paired with a different call. */
function groups(items: readonly ConversationItem[]): Group[] {
  const result: Group[] = [];
  for (const [index, item] of items.entries()) {
    const required = item.type === 'summary' || (item.type === 'text' && item.role === 'user');
    let group = result.at(-1);
    const afterResult = group?.items.some((entry) => entry.type === 'tool_result');
    if (!group || required || group.required || (afterResult && (item.type === 'reasoning' || item.type === 'text'))) {
      group = { start: index, items: [], required };
      result.push(group);
    }
    group.items.push(item);
  }
  return result;
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
  window?: number; outputReserve?: number; scale?: number; maxItems?: number;
}): ContextView {
  const window = input.window && input.window > 0 ? input.window : UNKNOWN_CONTEXT_WINDOW;
  const reserve = input.outputReserve ?? responseReserve(window);
  const budget = Math.max(0, window - reserve - Math.max(128, Math.ceil(window * 0.05)));
  const scale = Math.max(1, input.scale ?? 1);
  const cost = (items: readonly ConversationItem[], tools: readonly ToolSpec[]) => Math.ceil(estimateRequestTokens(input.system, items, tools) * scale);
  const maxItems = input.maxItems ?? 1_500;
  const initial = cost(input.items, input.tools);
  if (initial <= budget && input.items.length <= maxItems) return { items: input.items, tools: input.tools, estimatedTokens: initial, omittedGroups: 0 };

  const all = groups(input.items);
  const selected = new Set(all.filter((group) => group.required));
  const optional = all.filter((group) => !group.required);
  const last = optional.at(-1);
  // The immediate result is the evidence for the next action, even if an
  // older assistant narration would have scored higher on keyword overlap.
  if (last) selected.add(last);
  const query = textOf(input.items.filter((item) => item.type === 'text' && item.role === 'user').slice(-2)).toLowerCase();
  const words = new Set(query.match(/[\p{L}\p{N}_./-]{3,}/gu) ?? []);
  const ranked = optional.filter((group) => group !== last).map((group, index) => {
    const text = textOf(group.items).toLowerCase();
    let relevance = 0;
    for (const word of words) if (text.includes(word)) relevance++;
    return { group, score: relevance * 2 + index / Math.max(1, optional.length) };
  }).sort((a, b) => b.score - a.score);

  const materialize = (limit: number) => {
    const kept = all.filter((group) => selected.has(group));
    const items = kept.flatMap((group) => group.items.map((item, offset): ConversationItem => {
      if (group.required) return item;
      const reference = item.type === 'tool_result' ? `source=tool id=${JSON.stringify(item.id)}` : `source=history id="item:${group.start + offset}"`;
      if (item.type === 'tool_result') return { ...item, output: excerpt(item.output, limit, reference) };
      if (item.type === 'text') return { ...item, text: excerpt(item.text, limit, reference) };
      return item; // A signed reasoning block is preserved verbatim or omitted with its whole group.
    }));
    const referenced = new Set(items.flatMap((item) => item.type === 'tool_call' ? [item.name] : []));
    // Retain every declared tool used by the kept history. Unused, previously
    // loaded specialists can be rediscovered through their loader.
    const essential = new Set([...CORE_TOOLS, 'load_tools', 'load_mcp_tools']);
    // A just-requested specialist must be offered on the next step even
    // when its loader pushed the request over budget.
    for (const item of last?.items ?? []) {
      if (item.type === 'tool_call' && (item.name === 'load_tools' || item.name === 'load_mcp_tools') && Array.isArray(item.args.tools)) {
        for (const name of item.args.tools) if (typeof name === 'string') essential.add(name);
      }
    }
    const tools = input.tools.filter((tool) => referenced.has(tool.name) || essential.has(tool.name));
    const omitted = all.length - kept.length;
    const note: ConversationItem = { type: 'text', role: 'assistant', text: `[Working context: ${omitted} older work group(s) are outside this view. User requests remain verbatim. Use read_context to search the complete retained history and tool results before relying on missing details. Excerpts are not complete evidence.]` };
    return { items: omitted ? [note, ...items] : items, tools, omittedGroups: omitted };
  };

  let limit = Math.max(256, Math.min(4_096, Math.floor(window / 4)));
  let view = materialize(limit);
  while ((cost(view.items, view.tools) > budget || view.items.length > maxItems) && limit > 256) {
    limit = Math.max(256, Math.floor(limit / 2));
    view = materialize(limit);
  }
  if (cost(view.items, view.tools) > budget || view.items.length > maxItems) throw new ContextFitError(cost(view.items, view.tools) + reserve, window);
  for (const { group } of ranked) {
    selected.add(group);
    const candidate = materialize(limit);
    if (candidate.items.length <= maxItems && cost(candidate.items, candidate.tools) <= budget) view = candidate;
    else selected.delete(group);
  }
  return { ...view, estimatedTokens: cost(view.items, view.tools) };
}
