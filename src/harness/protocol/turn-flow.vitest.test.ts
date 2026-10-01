import { describe, expect, it } from 'vitest';
import {
  activityResult, endsWithSummary, exploreRuns, exploreSummary, pastePlaceholder, reasoningHeading, shimmerLevels, tensedLabel, turnStatus, turnSummary,
} from './turn-flow.js';

describe('how a turn reads', () => {
  it('words a row in the tense of its state', () => {
    expect(tensedLabel('Read src/a.ts', true)).toBe('Reading src/a.ts');
    expect(tensedLabel('Read src/a.ts', false)).toBe('Read src/a.ts');
    expect(tensedLabel('Edit src/a.ts', false)).toBe('Edited src/a.ts');
    expect(tensedLabel('Web search vitest', true)).toBe('Searching the web vitest');
    expect(tensedLabel('$ npm test', true)).toBe('$ npm test');
    expect(tensedLabel('github › create_issue title=x', false)).toBe('Called github › create_issue title=x');
    expect(tensedLabel('Agent review the tests', true)).toBe('Agent review the tests');
  });

  it('says what a finished call found, only from output it reported', () => {
    expect(activityResult({ kind: 'tool-done', label: 'Read a.ts', category: 'read', output: ['a', 'b'], outputOmitted: 40 })).toBe('42 lines');
    expect(activityResult({ kind: 'tool-done', label: 'Grep foo', category: 'search', output: ['a:1', 'b:2', 'c:3'] })).toBe('3 matches');
    expect(activityResult({ kind: 'tool-done', label: 'Glob *.ts', category: 'search', output: ['a.ts'] })).toBe('1 file');
    expect(activityResult({ kind: 'tool-done', label: 'Read a.ts', category: 'read' })).toBeUndefined();
    expect(activityResult({ kind: 'tool-start', label: 'Read a.ts', category: 'read', output: ['x'] })).toBeUndefined();
  });

  it('merges a run of reads and searches into one row, and leaves the rest alone', () => {
    const rows = [
      { kind: 'tool-done' as const, label: 'Read a.ts', category: 'read' as const },
      { kind: 'tool-done' as const, label: 'Grep foo', category: 'search' as const },
      { kind: 'tool-start' as const, label: 'Read b.ts', category: 'read' as const },
      { kind: 'tool-done' as const, label: '$ npm test', category: 'run' as const },
      { kind: 'tool-done' as const, label: 'Read c.ts', category: 'read' as const },
    ];
    const groups = exploreRuns(rows);
    expect(groups.map((group) => [group.explore, group.rows.length])).toEqual([[true, 3], [false, 1], [false, 1]]);
    expect(exploreSummary(groups[0]!.rows)).toBe('Reading 2 files, searching 1 pattern');
    expect(exploreSummary(rows.slice(0, 2))).toBe('Read 1 file, searched 1 pattern');
  });

  it('says what the turn is doing: you, the call, the reasoning, then the thinking in words', () => {
    expect(turnStatus({ asking: true, toolPhase: 'running tests' })).toEqual({ label: 'waiting for you', tone: 'asking', stall: 0 });
    expect(turnStatus({ toolPhase: 'running tests', quietMs: 60_000 })).toEqual({ label: 'running tests', tone: 'tool', stall: 0 });
    expect(turnStatus({ thought: '**Inspecting the parser** I should look at…', phase: 'thinking' }).label).toBe('Inspecting the parser');
    expect(turnStatus({ phase: 'thinking', thinkingMs: 25_000 }).label).toBe('thinking more');
    // A clock read just before the thinking began: still words, never a crash.
    expect(turnStatus({ phase: 'thinking', thinkingMs: -400 }).label).toBe('thinking');
    expect(turnStatus({ phase: 'thinking', thinkingMs: Number.NaN }).label).toBe('thinking');
    expect(turnStatus({ phase: 'generating response' }).label).toBe('generating response');
    expect(turnStatus({ phase: 'thinking', quietMs: 15_000 }).stall).toBeCloseTo(0.5);
    expect(turnStatus({ phase: 'thinking', quietMs: 30_000 }).tone).toBe('stalled');
    expect(reasoningHeading('no heading here')).toBeUndefined();
  });

  it('sweeps a highlight across the label', () => {
    const frame = shimmerLevels(10, 6);
    expect(frame[2]).toBe(1);
    expect(frame[9]).toBe(0);
    expect(Math.max(...shimmerLevels(10, 0))).toBe(0);
  });

  it('holds a long paste as a placeholder', () => {
    expect(pastePlaceholder('one line', 1)).toBeUndefined();
    expect(pastePlaceholder('a\nb\nc\nd\ne', 2)).toBe('[Pasted text #2 +5 lines]');
    expect(pastePlaceholder('x'.repeat(900), 3)).toBe('[Pasted text #3]');
  });

  it('ends a turn with how long it took and what it changed', () => {
    const edit = (path: string, additions: number, removals: number) => [{ path, change: 'modify' as const, additions, removals, lines: [] }];
    expect(turnSummary({ ms: 62_000, diffs: [edit('a.ts', 10, 2), edit('b.ts', 3, 0), edit('a.ts', 1, 1)] })).toBe('Worked for 1m 2s · 2 files changed +14 −3');
    expect(turnSummary({ ms: 400 })).toBe('Worked for 1s');
    expect(endsWithSummary(5_000, 0)).toBe(false);
    expect(endsWithSummary(5_000, 1)).toBe(true);
    expect(endsWithSummary(12_000, 0)).toBe(true);
  });
});
