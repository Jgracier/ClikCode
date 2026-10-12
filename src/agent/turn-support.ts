/** Small pure helpers of the agent loop: cancellation-aware waiting, call ids, tool rows. */
import { turnCancelledError } from './cancellation.js';
import type { ModelToolCall } from './model-client.js';
import type { ToolDefinition, ToolRunResult } from './tool-contract.js';
import type { ToolCategory } from '../harness/prompter.js';
import { TASK_TOOL_NAME } from './tools/task.js';
import { categoryOf, GATEWAY_HARNESS_COMMAND } from '../harness/protocol/tools.js';

/** A tool's class, for one the shared classifier cannot name (an MCP
 * server's, a skill). */
const CLASS_CATEGORY: Partial<Record<ToolDefinition['class'], ToolCategory>> = { exec: 'run', read: 'read', write: 'edit', network: 'fetch' };
export const SHELL_TOOLS: ReadonlySet<string> = new Set(['bash', 'bash_output', 'bash_input', 'kill_bash', 'wait']);

/** The gateway loop's row category: the tool's own name through the classifier
 * every harness's rows go through (so grep reads as a search here too), else
 * its class. The label is the command or the path, so it is never used. */
export function categoryForTool(tool: ToolDefinition | undefined, args?: Record<string, unknown>): { category?: ToolCategory; agent?: boolean } {
  // The turn is waiting on a sub-agent, which the UI shows as an agent row.
  if (!tool) return {};
  if (tool.name === TASK_TOOL_NAME || tool.name === 'agent') return { agent: true };
  const named = categoryOf(tool.name, args, GATEWAY_HARNESS_COMMAND);
  if (named.category) return named;
  const category = CLASS_CATEGORY[tool.class];
  return category ? { category } : {};
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Rejects as soon as the signal fires, even if `work` ignores it. */
export function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) { work.catch(() => undefined); return Promise.reject(turnCancelledError()); }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { work.catch(() => undefined); reject(turnCancelledError()); };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(signal.aborted ? turnCancelledError() : error); },
    );
  });
}

export interface CallOutcome { call: ModelToolCall; result: ToolRunResult }

/** Results are matched back to calls by id, and the model APIs reject a
 * repeated one, so a step that reuses an id (or sends none) gets distinct ones. */
export function withUniqueIds(calls: readonly ModelToolCall[]): ModelToolCall[] {
  const seen = new Set<string>();
  return calls.map((call, index) => {
    let id = call.id || `call_${index}`;
    for (let n = 2; seen.has(id); n++) id = `${call.id || 'call'}_${n}`;
    seen.add(id);
    return id === call.id ? call : { ...call, id };
  });
}
