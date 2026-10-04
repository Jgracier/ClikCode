import { describe, expect, it } from 'vitest';
import { renderActivityLine } from './activity-line.js';
import { mergeActivity, withChildTool } from './activity-view.js';
import { parseNativeActivityEventsFromValue, subAgentTotals } from './activity-events.js';
import type { AiLocalHarnessDefinition } from '../definition.js';

const claude = { command: 'claude', parser: 'claude-stream-json' } as unknown as AiLocalHarnessDefinition;

// eslint-disable-next-line no-control-regex
const plain = (line: string): string => line.replace(/\u001b\[[0-9;]*m/g, '');

describe('a sub-agent row', () => {
  it("counts the sub-agent's tool uses, as Claude Code does, and keeps the count to the end", () => {
    let agent = { kind: 'tool-start' as const, id: 'a', label: 'Task(explore)', agent: true };
    agent = withChildTool(withChildTool(agent, { kind: 'tool-start' }), { kind: 'tool-done' });
    const finished = mergeActivity(agent, { kind: 'tool-done', id: 'a', label: 'Task(explore)', durationMs: 65_000 });
    expect(plain(renderActivityLine(finished)[0]!)).toBe('  Task(explore) (1 tool use · 1m 5s)');
  });

  it("shows what the sub-agent spent when the harness reports it on the result, its count over the display's", () => {
    let agent = { kind: 'tool-start' as const, id: 'a', label: 'Task(explore)', agent: true };
    agent = withChildTool(agent, { kind: 'tool-start' });
    const result = parseNativeActivityEventsFromValue(claude, {
      type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'found it' }] },
      tool_use_result: { status: 'completed', totalDurationMs: 65_000, totalTokens: 30_412, totalToolUseCount: 12 },
    })[0]!;
    expect(result).toMatchObject({ kind: 'tool-done', id: 'a', childTools: 12, childTokens: 30_412, durationMs: 65_000 });
    const finished = mergeActivity(agent, result);
    expect(plain(renderActivityLine(finished)[0]!)).toBe('  Task(explore) (12 tool uses · 30k tokens · 1m 5s)');
    // An ordinary result reports none of it.
    expect(subAgentTotals({ stdout: 'ok' })).toEqual({});
  });
});
