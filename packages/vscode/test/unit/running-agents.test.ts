import { describe, expect, it } from 'vitest';
import { RunningAgents } from '../../src/webview/turn';
import type { Activity, LiveTurn } from '../../src/model';
import { freshLive, upsertActivity } from '../../src/model/activity';
import { BackgroundAgentRows } from '../../../../src/harness/events/background-agent-rows';

const agent = (key: string, kind: Activity['kind']): Activity => ({ key, id: key, kind, label: `Agent ${key}`, agent: true });

describe('composer subagents', () => {
  it('renders one agent when the async receipt links a launch to the task list', () => {
    const lifecycle = new BackgroundAgentRows();
    let live = upsertActivity(freshLive('thinking'), lifecycle.filter(agent('launch', 'tool-start'))!);
    const link = lifecycle.filter({ kind: 'tool-done', id: 'launch', label: 'tool' },
      [{ type: 'text', text: 'Async agent launched successfully.\nagentId: task-a (internal ID)' }])!;
    live = upsertActivity(live, link);
    live = { ...live, background: { agents: 1, agentTasks: [{ id: 'task-a', label: 'Review auth' }] } };
    const section = RunningAgents({ live })!;
    const children = (section as { props: { children: unknown[] } }).props.children;
    expect(children[0]).toHaveLength(1);
    const [end] = lifecycle.frame({ type: 'system', subtype: 'task_notification', tool_use_id: 'launch', task_id: 'task-a', status: 'completed' });
    live = upsertActivity(live, end!);
    expect(RunningAgents({ live: { ...live, background: undefined } })).toBeNull();
  });
  it('shows each running agent once and removes completed agents', () => {
    const live = { activities: [agent('a', 'tool-start'), agent('b', 'tool-start')] } as LiveTurn;
    const rows = (turn: LiveTurn): unknown[] => {
      const section = RunningAgents({ live: turn });
      const children = (section as { props: { children: unknown[] } }).props.children;
      return children[0] as unknown[];
    };
    expect(rows(live)).toHaveLength(2);
    expect(rows({ ...live, activities: [agent('a', 'tool-done'), agent('b', 'tool-start')] })).toHaveLength(1);
    expect(RunningAgents({ live: { ...live, activities: [agent('a', 'tool-done')] } })).toBeNull();
    expect(rows({ ...live, activities: [], background: { agents: 2, agentTasks: [
      { id: 'x', label: 'Review auth' }, { id: 'y', label: 'Run tests' },
    ] } })).toHaveLength(2);
    expect(rows({ ...live, activities: [{ ...agent('tool-x', 'tool-start'), agentId: 'x' }], background: {
      agents: 1, agentTasks: [{ id: 'x', label: 'Review auth' }],
    } })).toHaveLength(1);
    expect(RunningAgents({ live: { ...live, activities: [], background: { terminals: 2 } } })).not.toBeNull();
  });
});
