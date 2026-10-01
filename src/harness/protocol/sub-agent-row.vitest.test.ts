import { describe, expect, it } from 'vitest';
import { renderActivityLine } from './activity-line.js';
import { mergeActivity, withChildTool } from './activity-view.js';

// eslint-disable-next-line no-control-regex
const plain = (line: string): string => line.replace(/\u001b\[[0-9;]*m/g, '');

describe('a sub-agent row', () => {
  it("counts the sub-agent's tool uses, as Claude Code does, and keeps the count to the end", () => {
    let agent = { kind: 'tool-start' as const, id: 'a', label: 'Task(explore)', agent: true };
    agent = withChildTool(withChildTool(agent, { kind: 'tool-start' }), { kind: 'tool-done' });
    const finished = mergeActivity(agent, { kind: 'tool-done', id: 'a', label: 'Task(explore)', durationMs: 65_000 });
    expect(plain(renderActivityLine(finished)[0]!)).toBe('  Task(explore) (1 tool use, 1m 05s)');
  });
});
