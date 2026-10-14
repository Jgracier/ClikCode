import { describe, expect, it } from 'vitest';
import type { HarnessActivityEvent } from '../prompter.js';
import { callDetail, groupSummary, groupSummaryText, runsOf, standsAlone } from './call-groups.js';

const call = (id: string, category: HarnessActivityEvent['category'], label: string, extra: Partial<HarnessActivityEvent> = {}) => ({
  id, event: { kind: 'tool-done' as const, label, ...(category ? { category } : {}), id, ...extra },
});
const thought = (id: string) => ({ id, thought: { durationMs: 3000 } });

describe('a group of calls and thoughts, in words', () => {
  it('counts by kind in the order each kind first appeared, thoughts last', () => {
    const items = [
      call('1', 'run', '$ a'), call('2', 'run', '$ b'), call('3', 'read', 'Read a.ts'), call('4', 'run', '$ c'), call('5', 'read', 'Read b.ts'),
      call('6', 'search', 'Grep x'), call('7', 'run', '$ d'), call('8', 'edit', 'Edit a.ts'), thought('t1'), thought('t2'),
    ];
    const summary = groupSummary(items, false);
    expect(summary.calls).toBe('Ran 4 commands, read 2 files, searched 1 pattern, edited 1 file');
    expect(groupSummaryText(summary)).toBe('Ran 4 commands, read 2 files, searched 1 pattern, edited 1 file · 2 thoughts');
  });

  it('keeps the explore wording for a run that only looks around', () => {
    expect(groupSummary([call('1', 'read', 'Read a.ts'), call('2', 'read', 'Read b.ts'), call('3', 'search', 'Grep x')], false).calls)
      .toBe('Read 2 files, searched 1 pattern');
  });

  it('speaks in the present tense while it runs, and singular for one', () => {
    expect(groupSummary([call('1', 'run', '$ a'), call('2', 'fetch', 'Fetch x')], true).calls).toBe('Running 1 command, fetching 1 page');
    expect(groupSummary([call('1', undefined, 'mcp › tool'), call('2', undefined, 'mcp › two')], false).calls).toBe('Called 2 tools');
  });

  it('counts what failed or was stopped, but does not fold it', () => {
    const failed = call('3', 'run', '$ bad', { kind: 'tool-error' });
    const stopped = call('4', 'run', '$ sleep', { kind: 'tool-error', stopped: true });
    const agent = call('5', undefined, 'Task(x)', { agent: true });
    const summary = groupSummary([call('1', 'run', '$ a'), call('2', 'run', '$ b'), failed, stopped, agent], false);
    expect(groupSummaryText(summary)).toBe('Ran 2 commands · 1 failed · 1 stopped');
    expect([failed, stopped, agent, call('1', 'run', '$ a')].map((item) => standsAlone(item))).toEqual([true, true, true, false]);
  });

  it('keeps a call waiting on an approval as its own row', () => {
    const running = call('1', 'run', '$ rm', { kind: 'tool-start' });
    expect(standsAlone(running)).toBe(false);
    expect(standsAlone(running, (event) => event.id === '1')).toBe(true);
    expect(standsAlone(call('2', 'run', '$ ok'), () => true)).toBe(false);
  });
});

describe('what an expanded call shows', () => {
  it('gives the whole command, how it ended, and the tail of its output', () => {
    const output = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
    const detail = callDetail({
      kind: 'tool-done', label: '$ npm te…', category: 'run', output, outputTail: true, outputOmitted: 5, exitCode: 2, durationMs: 3400,
      call: { name: 'Bash', input: { command: 'npm test -- --reporter verbose' } },
    });
    expect(detail.command).toBe('$ npm test -- --reporter verbose');
    expect(detail.output).toHaveLength(20);
    expect(detail.output[19]).toBe('line 30');
    expect(detail.earlier).toBe(15);
    expect(detail.outcome).toContain('exit 2');
  });

  it('is the command only where the saved call has no output', () => {
    expect(callDetail({ kind: 'tool-done', label: 'Read a.ts', category: 'read' })).toEqual({ command: 'Read a.ts', output: [], earlier: 0 });
  });
});

describe('runs', () => {
  it('splits where the answer moved on', () => {
    expect(runsOf([{ offset: 0 }, { offset: 0 }, { offset: 12 }, { offset: 12 }, { offset: 40 }]).map((run) => run.length)).toEqual([2, 2, 1]);
  });
});
