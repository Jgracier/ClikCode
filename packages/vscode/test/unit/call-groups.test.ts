import { describe, expect, it } from 'vitest';
import { foldedSummary, runGroupSummary, runItemKey, runItemStandsAlone, type RunItem } from '../../src/webview/flow';
import type { Activity } from '../../src/model';

const call = (patch: Partial<Activity>): RunItem => ({ activity: { key: patch.label ?? 'k', kind: 'tool-done', label: 'tool', ...patch } });
const thought = (seq: number): RunItem => ({ thought: { text: 'hmm', offset: 0, ms: 3000, seq } });

describe('a run of calls and thoughts in the panel', () => {
  const items = [
    thought(1), call({ label: '$ npm test', category: 'run' }), call({ label: 'Read a.ts', category: 'read' }), call({ label: '$ ls', category: 'run' }),
    call({ label: 'Edit a.ts', category: 'edit' }), thought(2),
  ];

  it('says what it did in the terminal\'s words, by kind and thoughts last', () => {
    expect(runGroupSummary(items)).toBe('Ran 2 commands, read 1 file, edited 1 file · 2 thoughts');
  });

  it('counts a failed or stopped call and keeps it as a row of its own', () => {
    const failed = call({ label: '$ bad', category: 'run', kind: 'tool-error' });
    const stopped = call({ label: '$ sleep', category: 'run', kind: 'tool-error', stopped: true });
    expect(runGroupSummary([items[1]!, items[3]!, failed, stopped])).toBe('Ran 2 commands · 1 failed · 1 stopped');
    expect([failed, stopped, items[1]!, items[0]!, call({ label: 'Task', agent: true })].map(runItemStandsAlone)).toEqual([true, true, false, false, true]);
  });

  it('keeps the explore wording for a run that only looks around, and one call its own label', () => {
    expect(foldedSummary([call({ label: 'Read a.ts', category: 'read' }).activity!, call({ label: 'Read b.ts', category: 'read' }).activity!, call({ label: 'Grep x', category: 'search' }).activity!]))
      .toBe('Read 2 files, searched 1 pattern');
    expect(foldedSummary([call({ label: 'Edit a.ts', category: 'edit' }).activity!])).toBe('Edited a.ts');
  });

  it('keys an item by its call, or by its thought', () => {
    expect(items.map(runItemKey)).toEqual(['h1', '$ npm test', 'Read a.ts', '$ ls', 'Edit a.ts', 'h2']);
  });
});

describe('what an open call shows besides its output', () => {
  it('is the full command, what a tool was asked, and a sub-agent\'s task', async () => {
    const { activityMore } = await import('../../src/webview/flow.js');
    const run = call({ label: '$ npm te…', category: 'run', call: { name: 'Bash', input: { command: 'npm test --bail' } } }).activity!;
    expect(activityMore(run)).toEqual({ command: '$ npm test --bail', args: [] });
    const mcp = call({ label: 'github.search', call: { name: 'mcp__github__search', input: { query: 'bug', limit: 5 } } }).activity!;
    expect(activityMore(mcp)).toEqual({ args: ['query: bug', 'limit: 5'] });
    const agent = call({ label: 'Task(x)', agent: true, call: { name: 'Task', input: { prompt: 'Find the lexer.' } } }).activity!;
    expect(activityMore(agent)).toEqual({ task: 'Find the lexer.', args: [] });
    expect(activityMore(call({ label: 'Read a.ts', category: 'read' }).activity!)).toEqual({ args: [] });
  });

  it('counts a sub-agent in the run it is part of', () => {
    expect(runGroupSummary([call({ label: '$ a', category: 'run' }), call({ label: '$ b', category: 'run' }), call({ label: 'Task(x)', agent: true })])).toBe('Ran 2 commands, 1 agent');
  });
});
