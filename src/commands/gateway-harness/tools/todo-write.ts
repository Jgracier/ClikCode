import { defineTool, type PlanEntry } from '../types.js';

interface TodoWriteArgs { todos: PlanEntry[] }

export const todoWriteTool = defineTool<TodoWriteArgs>({
  name: 'todo_write',
  class: 'meta',
  description: 'Publish the full task list for multi-step work (replaces the previous list). Keep exactly one item in_progress, and mark items completed as soon as they are done. Skip it for trivial, single-step requests.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['todos'],
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false, required: ['content', 'status'],
          properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } },
        },
      },
    },
  },
  label: (args) => `Update plan (${args.todos.filter((todo) => todo.status === 'completed').length}/${args.todos.length} done)`,
  async run(args, ctx) {
    const entries = args.todos.map((todo) => ({ content: todo.content, status: todo.status }));
    ctx.onPlan?.(entries);
    const active = entries.filter((entry) => entry.status === 'in_progress').length;
    return { output: `Plan updated: ${entries.length} item(s).${active > 1 ? ' Note: keep only one item in_progress at a time.' : ''}` };
  },
});
