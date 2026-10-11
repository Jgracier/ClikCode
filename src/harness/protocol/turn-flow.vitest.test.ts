import { describe, expect, it } from 'vitest';
import {
  activityResult, answerWriting, decisionRow, isApprovalWaitPhase, endsWithSummary, estimateTokens, liveTokenTarget, smoothTokens, tokenMeterLabel, exploreRuns, exploreSummary, pastePlaceholder, reasoningBody, reasoningHeading, shimmerLevels, tensedLabel, turnStatus, turnSummary,
  backgroundTerminalsLabel,
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

  it('says what the turn is doing: you, the call, the reasoning, then writing or thinking', () => {
    expect(turnStatus({ asking: true, toolPhase: 'running tests' })).toEqual({ label: 'waiting for you', tone: 'asking' });
    expect(turnStatus({ toolPhase: 'running tests' })).toEqual({ label: 'running tests', tone: 'tool' });
    expect(turnStatus({ thought: '**Inspecting the parser** I should look at…', phase: 'thinking' }).label).toBe('Inspecting the parser');
    expect(turnStatus({ phase: 'thinking' }).label).toBe('thinking');
    expect(turnStatus({}).label).toBe('thinking');
    expect(turnStatus({ phase: 'generating response' }).label).toBe('generating response');
    expect(turnStatus({ phase: 'thinking', writing: true }).label).toBe('writing');
    expect(turnStatus({ phase: 'thinking', writing: true, toolPhase: 'running git' }).label).toBe('running git');
    expect(reasoningHeading('no heading here')).toBeUndefined();
  });

  it('keeps saying writing for as long as the answer is mid-stream, however long the pause', () => {
    // Text arrived at t=1000 and nothing since: a slow model, an ACP pause.
    // Under half-printed text the status must not fall back to "thinking".
    expect(answerWriting({ writingAt: 1000 })).toBe(true);
    // A call started after the text: the call's verb takes the line, and
    // once it ends with no new text the next response is "thinking" again.
    expect(answerWriting({ writingAt: 1000, callAt: 2000 })).toBe(false);
    // Text after that call: this response is being written.
    expect(answerWriting({ writingAt: 3000, callAt: 2000 })).toBe(true);
    expect(answerWriting({})).toBe(false);
    expect(answerWriting({ callAt: 5 })).toBe(false);
  });

  it('shows the reasoning under the status line without its heading or emphasis', () => {
    expect(reasoningBody('**Inspecting the parser** I should look at the **lexer** first')).toBe('I should look at the lexer first');
    expect(reasoningBody('**Inspecting the parser**')).toBe('');
    expect(reasoningBody('**Inspecting the')).toBe('');
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
    expect(turnSummary({ ms: 62_000, usage: '↑ 1.2k ↓ 340 tokens · $0.02' })).toBe('Worked for 1m 2s · ↑ 1.2k ↓ 340 tokens · $0.02');
    expect(turnSummary({ ms: 3000, stopped: true, usage: '↓ 12 tokens' })).toBe('Stopped after 3s · ↓ 12 tokens');
    expect(turnSummary({ ms: 3000, pendingBackground: 2 })).toBe('Waiting for 2 background agents');
    expect(turnSummary({ ms: 3000, pendingBackground: 1 })).toBe('Waiting for 1 background agent');
    expect(turnSummary({ ms: 3000, pendingBackground: 0 })).toBe('Worked for 3s');
    // Claude Code's own words: `N background agents and N dynamic workflows`.
    expect(turnSummary({ ms: 3000, pendingBackground: 2, pendingWorkflows: 1 })).toBe('Waiting for 2 background agents and 1 dynamic workflow');
    expect(turnSummary({ ms: 3000, pendingWorkflows: 2 })).toBe('Waiting for 2 dynamic workflows');
    expect(turnSummary({ ms: 3000, pendingWorkflows: 0, pendingBackground: 0 })).toBe('Worked for 3s');
    expect(turnSummary({ ms: 3000, pendingBackground: 1, pendingWorkflows: 1, usage: '↓ 12 tokens' })).toBe('Waiting for 1 background agent and 1 dynamic workflow · ↓ 12 tokens');
  });

  it('says background terminals as a footer indicator, singular and plural, nothing at zero; never on the end line', () => {
    expect(backgroundTerminalsLabel(1)).toBe('1 background terminal running');
    expect(backgroundTerminalsLabel(3)).toBe('3 background terminals running');
    expect(backgroundTerminalsLabel(0)).toBeUndefined();
    expect(backgroundTerminalsLabel(undefined)).toBeUndefined();
    expect(turnSummary({ ms: 3000, backgroundTerminals: 2 } as never)).toBe('Worked for 3s');
    expect(endsWithSummary(5_000, 0)).toBe(false);
    expect(endsWithSummary(5_000, 1)).toBe(true);
    expect(endsWithSummary(12_000, 0)).toBe(true);
  });

  it('counts a running turn\'s tokens: the vendor\'s figure, else length / 4, never going down', () => {
    expect(estimateTokens(4000)).toBe(1000);
    expect(estimateTokens(0)).toBe(0);
    // Reported output wins where the turn's usage so far has it.
    expect(liveTokenTarget({ usage: { output: 340 }, responseChars: 4000 })).toBe(340);
    expect(liveTokenTarget({ usage: { input: 900 }, responseChars: 4000 })).toBe(1000);
    expect(liveTokenTarget({ responseChars: 0 })).toBe(0);
    // The shown number steps toward the target, and never back.
    const a = smoothTokens(0, 1000);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1000);
    expect(smoothTokens(a, 1000)).toBeGreaterThan(a);
    expect(smoothTokens(500, 100)).toBe(500);
    expect(smoothTokens(999, 1000)).toBe(1000);
  });

  it('words the meter as Claude Code does, only once there is something to count', () => {
    expect(tokenMeterLabel(1234)).toBe('↓ 1.2k tokens');
    expect(tokenMeterLabel(42)).toBe('↓ 42 tokens');
    expect(tokenMeterLabel(0)).toBeUndefined();
  });

  it('words what a decision leaves behind, and never shows a secret answer', () => {
    expect(decisionRow({ kind: 'approved', label: 'make build' })).toEqual({ text: '✓ approved make build', tone: 'ok' });
    expect(decisionRow({ kind: 'approved', label: 'make build', always: true }).text).toBe('✓ approved (always) make build');
    expect(decisionRow({ kind: 'denied', label: 'make clean' })).toEqual({ text: '✗ denied make clean', tone: 'no' });
    expect(decisionRow({ kind: 'told', text: 'use pnpm\ninstead' })).toEqual({ text: '↳ told: use pnpm instead', tone: 'told' });
    expect(decisionRow({ kind: 'answered', label: 'Which database?', values: ['MySQL'] }).text).toBe('✓ answered Which database?: MySQL');
    expect(decisionRow({ kind: 'answered', label: 'API key' }).text).toBe('✓ answered API key');
    expect(decisionRow({ kind: 'declined', label: 'Which database?' }).text).toBe('✗ declined Which database?');
  });

  it('knows the adapters\' approval phase, which is stale once the approval is answered', () => {
    expect(isApprovalWaitPhase('waiting for your approval: make clean')).toBe(true);
    expect(isApprovalWaitPhase('waiting for your answer')).toBe(true);
    expect(isApprovalWaitPhase('waiting for reset')).toBe(false);
    expect(isApprovalWaitPhase('reading files')).toBe(false);
    expect(isApprovalWaitPhase(undefined)).toBe(false);
  });
});

import { categoryOf, toolLabel } from './tools.js';
import { explores } from './turn-flow.js';

describe('a list call is an explore-group member (standard section 6)', () => {
  it.each(['list', 'List', 'list_directory', 'listDirectory', 'ls', 'list_files', 'read_dir'])('%s classifies as a looking-around call', (name) => {
    const { category } = categoryOf(name, { path: 'src' });
    expect(category).toBe('search');
    expect(explores({ category, kind: 'tool-done' })).toBe(true);
  });

  it('one run of Read, Grep, Glob and List is one group', () => {
    const rows = ['Read', 'Grep', 'Glob', 'list_directory'].map((name) => ({
      kind: 'tool-done' as const, ...categoryOf(name, name === 'Grep' ? { pattern: 'x' } : { path: 'a' }), label: toolLabel(name, { path: 'a' }),
    }));
    const groups = exploreRuns(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.explore).toBe(true);
    expect(groups[0]!.rows).toHaveLength(4);
  });
});
