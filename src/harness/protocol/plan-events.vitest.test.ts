import { describe, expect, it } from 'vitest';
import { isTodoWriteTool, normalizePlanStatus, planFromRecord, planFromTodoInput } from './plan-events.js';

describe('a harness todo tool becomes the plan', () => {
  it('reads Claude Code\'s TodoWrite from a real stream record', () => {
    // Shape verified against a real Claude Code session transcript.
    const record = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [
        { content: 'Compute the truth spine', status: 'completed', activeForm: 'Computing' },
        { content: 'Parse subscription usage', status: 'in_progress', activeForm: 'Parsing' },
        { content: 'Ship it', status: 'pending', activeForm: 'Shipping' },
      ] } }] },
    };
    expect(planFromRecord(record)).toEqual([
      { content: 'Compute the truth spine', status: 'completed' },
      { content: 'Parse subscription usage', status: 'in_progress' },
      { content: 'Ship it', status: 'pending' },
    ]);
  });

  it('reads every verified name and list shape: Gemini, Qwen/Grok, OpenCode, Codex, Cursor', () => {
    expect(planFromRecord({ type: 'tool_use', tool_name: 'write_todos', parameters: { todos: [{ description: 'a', status: 'in_progress' }] } }))
      .toEqual([{ content: 'a', status: 'in_progress' }]);
    expect(planFromRecord({ message: { content: [{ type: 'tool_use', name: 'todo_write', input: { todos: [{ content: 'b', status: 'pending' }] } }] } }))
      .toEqual([{ content: 'b', status: 'pending' }]);
    expect(planFromRecord({ type: 'tool_use', part: { tool: 'todowrite', state: { input: { todos: [{ content: 'c', status: 'completed', priority: 'high' }] } } } }))
      .toEqual([{ content: 'c', status: 'completed', priority: 'high' }]);
    expect(planFromTodoInput('{"plan":[{"step":"d","status":"in_progress"}]}')).toEqual([{ content: 'd', status: 'in_progress' }]);
    expect(planFromRecord({ type: 'tool_call', subtype: 'started', tool_call: { updateTodosToolCall: { args: { todos: [{ content: 'e', status: 'TODO_STATUS_IN_PROGRESS' }] } } } }))
      .toEqual([{ content: 'e', status: 'in_progress' }]);
  });

  it('ignores reading tools, other tools and lists with no text', () => {
    expect(isTodoWriteTool('TodoRead')).toBe(false);
    expect(planFromRecord({ message: { content: [{ type: 'tool_use', name: 'Bash', input: { todos: [{ content: 'x' }] } }] } })).toBeUndefined();
    expect(planFromTodoInput({ todos: [{ status: 'pending' }] })).toBeUndefined();
  });

  it('speaks one status vocabulary', () => {
    expect(['done', 'inProgress', 'TODO_STATUS_COMPLETED', 'canceled', 'todo'].map(normalizePlanStatus))
      .toEqual(['completed', 'in_progress', 'completed', 'cancelled', 'pending']);
  });
});

describe('Claude Code\'s task tools build the list a call at a time', () => {
  it('follows real TaskCreate results and TaskUpdate calls to the whole list', async () => {
    const { TaskListTracker } = await import('./plan-events.js');
    const tracker = new TaskListTracker();
    // Shapes copied from a real Claude Code 2.1.281 stream.
    const created = (id: string, subject: string) => ({ type: 'user', tool_use_result: { task: { id, subject } } });
    const update = (taskId: string, status: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'TaskUpdate', input: { taskId, status } }] } });
    const lists = [
      created('1', 'Create a.txt'), created('2', 'Create b.txt'),
      update('1', 'in_progress'), update('1', 'completed'), update('2', 'deleted'),
      { type: 'assistant', message: { content: [{ type: 'text', text: 'unrelated' }] } },
    ].map((record) => tracker.apply(record));
    expect(lists[1]).toEqual([{ content: 'Create a.txt', status: 'pending' }, { content: 'Create b.txt', status: 'pending' }]);
    expect(lists[3]).toEqual([{ content: 'Create a.txt', status: 'completed' }, { content: 'Create b.txt', status: 'pending' }]);
    expect(lists[4]).toEqual([{ content: 'Create a.txt', status: 'completed' }]);
    expect(lists[5]).toBeUndefined();
  });
});
