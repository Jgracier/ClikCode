import { describe, expect, it } from 'vitest';
import { liveAgentRows } from './live-agents.js';
import { upsertActivityEvent } from './activity-log.js';
import { BackgroundAgentRows } from '../../harness/events/background-agent-rows.js';

const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');

describe('composer subagents', () => {
  it('joins an SDK async launch receipt to its task list when task_started is missing', () => {
    const lifecycle = new BackgroundAgentRows();
    const start = lifecycle.filter({ kind: 'tool-start', id: 'launch', label: 'Agent Review auth', agent: true })!;
    let entries = upsertActivityEvent([], 0, 0, start);
    const frames = lifecycle.frame({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'launch',
      content: [{ type: 'text', text: 'Async agent launched successfully.\nagentId: task-a (internal ID)' }] }] } });
    expect(frames).toHaveLength(1);
    expect(lifecycle.filter({ kind: 'tool-done', id: 'launch', label: 'tool' })).toBeUndefined();
    for (const frame of frames) entries = upsertActivityEvent(entries, 0, 0, frame);
    expect(liveAgentRows(entries, () => undefined, 0, 80, 5, {
      agents: 1, agentTasks: [{ id: 'task-a', label: 'Review auth' }],
    })).toHaveLength(1);
    const [end] = lifecycle.frame({ type: 'system', subtype: 'task_notification', tool_use_id: 'launch', task_id: 'task-a', status: 'completed' });
    entries = upsertActivityEvent(entries, 0, 0, end!);
    expect(liveAgentRows(entries, () => undefined, 0, 80, 5)).toHaveLength(0);
    expect(lifecycle.frame({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'unrelated-command',
      content: 'Async agent launched successfully.\nagentId: task-a (internal ID)' }] } })).toEqual([]);
  });
  it('links Claude launch calls to background tasks before progress, keeping distinct agents with the same label', () => {
    const lifecycle = new BackgroundAgentRows();
    let entries: ReturnType<typeof upsertActivityEvent> = [];
    for (const id of ['a', 'b']) {
      const launch = lifecycle.filter({ kind: 'tool-start', id: `call-${id}`, label: 'Agent Review auth', agent: true })!;
      entries = upsertActivityEvent(entries, 0, 0, launch);
      for (const event of lifecycle.frame({ type: 'system', subtype: 'task_started',
        tool_use_id: `call-${id}`, task_id: `task-${id}`, is_backgrounded: true,
        ...(id === 'a' ? { subagent_type: 'general-purpose' } : { task_type: 'local_agent' }) })) {
        entries = upsertActivityEvent(entries, 0, 0, event);
      }
    }
    expect(entries.map((entry) => entry.event?.agentId)).toEqual(['task-a', 'task-b']);
    const rows = liveAgentRows(entries, () => undefined, 0, 80, 5, {
      agents: 2, agentTasks: [{ id: 'task-a', label: 'Review auth' }, { id: 'task-b', label: 'Review auth' }],
    }).map(plain);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.includes('Agent Review auth'))).toBe(true);
  });
  it('keeps one row per running agent, updates its child, and removes it on completion', () => {
    let entries = upsertActivityEvent([], 0, 0, { kind: 'tool-start', id: 'a', label: 'Review files', agent: true }, 1);
    entries = upsertActivityEvent(entries, 0, 0, { kind: 'tool-start', id: 'b', label: 'Run tests', agent: true }, 2);
    entries = upsertActivityEvent(entries, 0, 0, { kind: 'tool-start', id: 'a', label: 'Review files', agent: true }, 3);
    const rows = liveAgentRows(entries, (id) => id === 'a' ? 'Reading package.json' : undefined, 0, 80, 5).map(plain);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Review files  ·  Reading package.json');
    expect(rows[1]).toContain('Run tests');
    entries = upsertActivityEvent(entries, 0, 0, { kind: 'tool-done', id: 'a', label: 'Review files', agent: true }, 4);
    expect(liveAgentRows(entries, () => undefined, 0, 80, 5).map(plain).join(' ')).toContain('Run tests');
    expect(liveAgentRows(entries, () => undefined, 0, 80, 5).map(plain).join(' ')).not.toContain('Review files');
  });
  it('keeps the footer within its row budget', () => {
    const entries = ['a', 'b', 'c'].reduce((rows, id, index) => upsertActivityEvent(rows, 0, 0,
      { kind: 'tool-start', id, label: `Agent ${id}`, agent: true }, index + 1), [] as ReturnType<typeof upsertActivityEvent>);
    expect(liveAgentRows(entries, () => undefined, 0, 80, 1)).toHaveLength(1);
    const rows = liveAgentRows(entries, () => undefined, 0, 80, 2).map(plain);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('+2 other subagents running');
    expect(rows[1]).toContain('Agent c');
  });
  it('keeps named background agents visible after their parent call closes', () => {
    const rows = liveAgentRows([], () => undefined, 0, 80, 5, {
      agents: 2, agentTasks: [{ id: 'a', label: 'Review auth' }, { id: 'b', label: 'Run tests' }],
    }).map(plain);
    expect(rows).toHaveLength(2);
    expect(rows.join(' ')).toContain('Review auth');
    expect(rows.join(' ')).toContain('Run tests');
    expect(liveAgentRows([], () => undefined, 0, 80, 5, { agents: 2 })).toHaveLength(2);
    const started = upsertActivityEvent([], 0, 0, { kind: 'tool-start', id: 'tool-a', agentId: 'a', label: 'Review auth', agent: true }, 1);
    expect(liveAgentRows(started, () => undefined, 0, 80, 5, { agents: 1, agentTasks: [{ id: 'a', label: 'Review auth' }] })).toHaveLength(1);
  });
});
