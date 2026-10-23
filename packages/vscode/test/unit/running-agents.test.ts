import { describe, expect, it } from 'vitest';
import { RunningAgents } from '../../src/webview/turn';
import type { Activity, LiveTurn } from '../../src/model';

const agent = (key: string, kind: Activity['kind']): Activity => ({ key, id: key, kind, label: `Agent ${key}`, agent: true });

describe('composer subagents', () => {
  it('shows each running agent once and removes completed agents', () => {
    const live = { activities: [agent('a', 'tool-start'), agent('b', 'tool-start')] } as LiveTurn;
    const rows = (turn: LiveTurn): unknown[] => {
      const section = RunningAgents({ live: turn });
      const children = (section as { props: { children: Array<{ props: { children: unknown[] } }> } }).props.children;
      return children[1]!.props.children;
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
