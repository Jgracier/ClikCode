/** A harness's todo list, read from its own todo tool call.
 *
 * ACP harnesses publish a plan (`session/update` plan) and Codex a
 * `turn/plan/updated`; every structured-CLI harness instead writes its list
 * with a TOOL, whose input is the whole list. Verified names: Claude Code and
 * Cursor `TodoWrite`, Grok and Qwen `todo_write`, OpenCode `todowrite`,
 * Gemini `write_todos`, Codex `update_plan`. One reader for all of them: a
 * tool whose name is a todo-writing name and whose input holds a list of
 * items with text becomes the plan, so a harness that adopts one of these
 * names needs no code here.
 *
 * Shapes seen: `{todos:[{content,status,activeForm}]}` (Claude),
 * `{todos:[{description,status}]}` (Gemini), `{plan:[{step,status}]}` (Codex),
 * statuses `pending|in_progress|completed|cancelled` or Cursor-style
 * `TODO_STATUS_IN_PROGRESS`. */

import type { HarnessPlanEntry } from '../events/turn-observer.js';

type Json = Record<string, unknown>;

/** Tool names that WRITE a todo list, compared lower-cased with separators and
 * a trailing "toolcall" removed. Reading tools (todoread) are not here. */
const TODO_WRITERS = new Set(['todowrite', 'writetodos', 'updatetodos', 'todoupdate', 'updateplan', 'settodos', 'todos']);
const LIST_KEYS = ['todos', 'plan', 'items', 'tasks', 'steps', 'entries'] as const;
const TEXT_KEYS = ['content', 'description', 'step', 'text', 'title', 'task'] as const;

function record(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
}

export function isTodoWriteTool(name: string): boolean {
  return TODO_WRITERS.has(name.toLowerCase().replace(/[^a-z]/g, '').replace(/toolcall$/, ''));
}

/** `in_progress`, `inProgress`, `TODO_STATUS_IN_PROGRESS`, `done`... → the shared vocabulary. */
export function normalizePlanStatus(status: unknown): string | undefined {
  if (typeof status !== 'string' || !status) return undefined;
  const s = status.toLowerCase().replace(/^todo_status_/, '').replace(/[^a-z]/g, '');
  if (/^(completed|complete|done|finished)$/.test(s)) return 'completed';
  if (/^(inprogress|active|running|doing|started|current)$/.test(s)) return 'in_progress';
  if (/^(cancelled|canceled|skipped)$/.test(s)) return 'cancelled';
  if (/^(pending|todo|open|notstarted)$/.test(s)) return 'pending';
  return status;
}

/** The plan a todo tool's input carries, or undefined when it carries none. */
export function planFromTodoInput(input: unknown): HarnessPlanEntry[] | undefined {
  let value: unknown = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      // fail-open-ok: arguments that are not JSON carry no list; the tool row still shows.
      return undefined;
    }
  }
  const args = record(value);
  if (!args) return undefined;
  const list = LIST_KEYS.map((key) => args[key]).find(Array.isArray) as unknown[] | undefined;
  if (!list) return undefined;
  const entries: HarnessPlanEntry[] = [];
  for (const raw of list) {
    const item = record(raw);
    const text = item && TEXT_KEYS.map((key) => item[key]).find((v) => typeof v === 'string' && v.trim());
    if (!item || typeof text !== 'string') continue;
    const status = normalizePlanStatus(item.status);
    entries.push({ content: text, ...(status ? { status } : {}), ...(typeof item.priority === 'string' ? { priority: item.priority } : {}) });
  }
  return entries.length ? entries : undefined;
}

/** Cheap pre-check on the raw line, so only records that mention a todo tool are walked. */
export const MENTIONS_TODO_TOOL = /todo|update_?plan/i;

/** The todo list one stream record carries, if it starts a todo-writing tool.
 * Walks the record a few levels deep: Claude-shaped `tool_use` blocks sit in
 * `message.content`, OpenCode's in `part`, Cursor wraps the call under a key
 * named for the tool (`{tool_call: {updateTodosToolCall: {args}}}`). */
export function planFromRecord(value: unknown, depth = 0): HarnessPlanEntry[] | undefined {
  if (depth > 6) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const plan = planFromRecord(item, depth + 1);
      if (plan) return plan;
    }
    return undefined;
  }
  const node = record(value);
  if (!node) return undefined;
  const name = [node.name, node.tool, node.toolName, node.tool_name].find((v) => typeof v === 'string') as string | undefined;
  if (name && isTodoWriteTool(name)) {
    const state = record(node.state);
    const input = node.input ?? node.args ?? node.arguments ?? node.parameters ?? node.params ?? state?.input;
    const plan = planFromTodoInput(input);
    if (plan) return plan;
  }
  for (const [key, child] of Object.entries(node)) {
    if (!child || typeof child !== 'object') continue;
    if (isTodoWriteTool(key)) {
      const wrapped = record(child);
      const plan = planFromTodoInput(wrapped?.args ?? wrapped?.input ?? wrapped?.arguments ?? child);
      if (plan) return plan;
    }
    const plan = planFromRecord(child, depth + 1);
    if (plan) return plan;
  }
  return undefined;
}

/** Claude Code's task tools build the list one call at a time instead:
 * `TaskCreate {subject}` (its id arrives in the result, `tool_use_result.task
 * {id, subject}`), `TaskUpdate {taskId, status, subject?}`, status `deleted`
 * removing one. Verified against Claude Code 2.1.281's stream. This keeps the
 * list a turn has built and answers the whole of it after every change. */
export class TaskListTracker {
  private readonly tasks = new Map<string, HarnessPlanEntry>();

  /** The list after this record, or undefined when the record changed nothing. */
  apply(value: unknown): HarnessPlanEntry[] | undefined {
    const node = record(value);
    if (!node) return undefined;
    let changed = false;
    const created = record(record(node.tool_use_result)?.task);
    if (created && typeof created.id === 'string' && typeof created.subject === 'string') {
      this.tasks.set(created.id, { content: created.subject, ...(this.tasks.get(created.id)?.status ? { status: this.tasks.get(created.id)!.status! } : { status: 'pending' }) });
      changed = true;
    }
    const content = record(node.message)?.content;
    for (const block of Array.isArray(content) ? content : []) {
      const use = record(block);
      if (use?.type !== 'tool_use' || use.name !== 'TaskUpdate') continue;
      const input = record(use.input);
      const id = input && (typeof input.taskId === 'string' ? input.taskId : typeof input.taskId === 'number' ? String(input.taskId) : undefined);
      if (!id) continue;
      if (input.status === 'deleted') {
        changed = this.tasks.delete(id) || changed;
        continue;
      }
      const existing = this.tasks.get(id);
      const subject = typeof input.subject === 'string' && input.subject.trim() ? input.subject : existing?.content;
      if (!subject) continue;
      const status = normalizePlanStatus(input.status) ?? existing?.status;
      this.tasks.set(id, { content: subject, ...(status ? { status } : {}) });
      changed = true;
    }
    return changed ? this.list() : undefined;
  }

  private list(): HarnessPlanEntry[] {
    return [...this.tasks.entries()]
      .sort(([a], [b]) => (Number(a) - Number(b)) || a.localeCompare(b))
      .map(([, entry]) => ({ ...entry }));
  }
}

/** Cheap pre-check for Claude's task tools, so only their records are parsed. */
export const MENTIONS_TASK_TOOL = /"TaskUpdate"|"tool_use_result":\{"task"/;
