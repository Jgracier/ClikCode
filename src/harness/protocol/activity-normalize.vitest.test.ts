import { describe, expect, it } from 'vitest';
import type { HarnessActivityEvent } from '../prompter.js';
import { normalizeActivityEvent, OUTPUT_LINES } from './activity-normalize.js';

const n = (event: HarnessActivityEvent): HarnessActivityEvent => normalizeActivityEvent(event);

describe('normalizeActivityEvent', () => {
  it('assigns a category from the call, a diff, or the verb the label starts with', () => {
    expect(n({ kind: 'tool-start', label: 'x', call: { name: 'exec_command', input: { cmd: 'ls' } } }).category).toBe('run');
    expect(n({ kind: 'tool-start', label: 'Edit a.ts', diff: [{ path: 'a.ts', additions: 1, removals: 0, lines: [] }] as never }).category).toBe('edit');
    expect(n({ kind: 'tool-start', label: '$ ls' }).category).toBe('run');
    expect(n({ kind: 'tool-start', label: 'Read a.ts' }).category).toBe('read');
    expect(n({ kind: 'tool-start', label: 'Web search cats' }).category).toBe('fetch');
    expect(n({ kind: 'tool-start', label: 'github › create_issue' }).category).toBeUndefined();
    expect(n({ kind: 'tool-done', label: 'tool' }).category).toBeUndefined();
  });

  it('rewrites a vendor spelling of a row into the shared one', () => {
    expect(n({ kind: 'tool-start', label: 'Bash(npm test)' })).toMatchObject({ label: '$ npm test', category: 'run' });
    expect(n({ kind: 'tool-start', label: 'Read(src/a.ts)' })).toMatchObject({ label: 'Read src/a.ts', category: 'read' });
    expect(n({ kind: 'tool-start', label: '`npm test`', category: 'run' }).label).toBe('$ npm test');
    expect(n({ kind: 'tool-start', label: 'Read config', id: 'a', category: 'read', call: { name: 'Read', input: { file_path: 'a.ts' } } }).label).toBe('Read a.ts');
    expect(n({ kind: 'tool-start', label: 'Task(review the tests)', agent: true }).label).toBe('Agent review the tests');
  });

  it('settles a command with a non-zero exit as an error, never a stopped one', () => {
    expect(n({ kind: 'tool-done', label: '$ false', category: 'run', exitCode: 1 }).kind).toBe('tool-error');
    expect(n({ kind: 'tool-done', label: '$ true', category: 'run', exitCode: 0 }).kind).toBe('tool-done');
    expect(n({ kind: 'tool-error', label: '$ x', category: 'run', stopped: true, exitCode: 1 }).kind).toBe('tool-error');
  });

  it('bounds output: a command keeps its tail, anything else its start', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `l${i}`);
    const run = n({ kind: 'tool-done', label: '$ x', category: 'run', output: lines });
    expect(run.output).toHaveLength(OUTPUT_LINES);
    expect(run.output![OUTPUT_LINES - 1]).toBe('l99');
    expect(run).toMatchObject({ outputOmitted: 40, outputTail: true });
    const read = n({ kind: 'tool-done', label: 'Read a', category: 'read', output: lines });
    expect(read.output![0]).toBe('l0');
    expect(read.outputOmitted).toBe(40);
  });

  it('gives a thought one shape, and is idempotent', () => {
    const thought = n({ kind: 'thinking', label: `  a\n\n b ${'x'.repeat(400)}` });
    expect(thought.label.length).toBeLessThanOrEqual(240);
    expect(thought.label).not.toMatch(/\s{2}/);
    expect(n(thought)).toBe(thought);
  });

  it('returns the same object for an event already in shape, and the same result twice', () => {
    const event: HarnessActivityEvent = { kind: 'tool-done', label: '$ ls', category: 'run', id: 'a', output: ['x'], exitCode: 0 };
    expect(n(event)).toBe(event);
    const rewritten = n({ kind: 'tool-start', label: 'Bash(ls)' });
    expect(n(rewritten)).toBe(rewritten);
  });
});
