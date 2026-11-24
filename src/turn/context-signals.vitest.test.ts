import { describe, expect, it } from 'vitest';
import { createSignalTracker, isCorrection, shellReads } from './context-signals.js';

const read = (id: string, path: string) => ({ kind: 'tool-start', id, category: 'read', call: { name: 'Read', input: { file_path: path } } });

describe('context signals', () => {
  it('counts a call from the frame that carries its arguments, not the name-only one before it', () => {
    const files: string[] = [];
    const tracker = createSignalTracker(files);
    tracker.note({ kind: 'tool-start', id: 'r1', category: 'read' });
    tracker.note({ kind: 'tool-start', id: 'r1', category: 'read', call: { name: 'Read', input: {} } });
    tracker.note(read('r1', '/a'));
    tracker.note(read('r1', '/a'));
    tracker.note({ kind: 'tool-done', id: 'r1' });
    expect(files).toEqual(['/a']);
    tracker.note({ kind: 'tool-start', id: 'r2', category: 'read', call: { name: 'Read', input: {} } });
    tracker.note(read('r2', '/a'));
    expect(tracker.counts('x').reReads).toBe(1);
  });

  it('counts a file read again, not one changed in between', () => {
    const files: string[] = ['/a'];
    const tracker = createSignalTracker(files);
    tracker.note(read('1', '/a'));
    tracker.note(read('1', '/a')); // the same call twice is one
    tracker.note(read('2', '/b'));
    tracker.note({ kind: 'tool-start', id: '3', category: 'edit', call: { name: 'Edit', input: { path: '/b' } } });
    tracker.note(read('4', '/b'));
    expect(tracker.counts('go on').reReads).toBe(1);
    expect(files).toEqual(['/a', '/b']);
  });

  it('counts hindsight searches and the empty ones', () => {
    const tracker = createSignalTracker([]);
    tracker.note({ kind: 'tool-start', id: 'h1', call: { name: 'mcp__clikcode__hindsight' } });
    tracker.note({ kind: 'tool-done', id: 'h1', output: ['"x" does not come up in this chat'] });
    tracker.note({ kind: 'tool-start', id: 'h2', call: { name: 'hindsight' } });
    tracker.note({ kind: 'tool-done', id: 'h2', output: ['found it'] });
    tracker.note({ kind: 'tool-start', id: 'h3', call: { name: 'clikcode.hindsight' } });
    tracker.note({ kind: 'tool-error', id: 'h3' });
    tracker.note({ kind: 'tool-start', id: 'n', call: { name: 'not_hindsight_tool' } });
    const counts = tracker.counts('next');
    expect(counts).toMatchObject({ turns: 1, hindsight: 3, hindsightEmpty: 2, corrections: 0 });
  });

  it('leaves a subagent\'s calls out', () => {
    const files = ['/a'];
    const tracker = createSignalTracker(files);
    tracker.note({ ...read('1', '/a'), parentId: 'agent' });
    tracker.note({ kind: 'tool-start', id: 'h', parentId: 'agent', call: { name: 'hindsight' } });
    expect(tracker.counts('x')).toMatchObject({ reReads: 0, hindsight: 0 });
  });

  it('reads a correction or a repeat in the request', () => {
    expect(isCorrection('I already told you the port is 8080')).toBe(true);
    expect(isCorrection('as I said, use main')).toBe(true);
    expect(isCorrection('you forgot the tests')).toBe(true);
    expect(isCorrection('add a test for the parser')).toBe(false);
  });
});

const run = (id: string, command: unknown) => ({ kind: 'tool-start', id, category: 'run', call: { name: 'Bash', input: { command } } });

describe('a read whose arguments arrive a field at a time (claude-agent-acp)', () => {
  // What claude-agent-acp 0.110 sends for Read(offset 401, limit 400): the kind and title once,
  // then rawInput growing a field at a time with neither, then the whole input.
  const frames = (id: string, offset: number) => [
    { kind: 'tool-start', id, category: 'read' },
    { kind: 'tool-start', id, call: { name: 'read', input: { file_path: '/w/n.txt' } } },
    { kind: 'tool-start', id, call: { name: 'read', input: { file_path: '/w/n.txt', offset } } },
    { kind: 'tool-start', id, category: 'read', call: { name: 'Read', input: { file_path: '/w/n.txt', offset, limit: 400 } } },
  ];

  it('counts pages of one file as pages, and only the page read twice as a re-read', () => {
    const files: string[] = [];
    const tracker = createSignalTracker(files);
    for (const [id, offset] of [['p1', 1], ['p2', 401], ['p3', 801], ['p4', 1]] as const) {
      for (const frame of frames(id, offset)) tracker.note(frame);
      tracker.note({ kind: 'tool-done', id });
    }
    expect(tracker.counts('x').reReads).toBe(1);
    expect(files).toEqual(['/w/n.txt#[401,400]', '/w/n.txt#[801,400]', '/w/n.txt#[1,400]']);
  });

  it('counts a read the turn never saw end, in the order it ran around an edit', () => {
    const files: string[] = [];
    const tracker = createSignalTracker(files);
    for (const frame of frames('a', 1)) tracker.note(frame);
    tracker.note({ kind: 'tool-start', id: 'e', category: 'edit', call: { name: 'Edit', input: { file_path: '/w/n.txt' } } });
    for (const frame of frames('b', 1)) tracker.note(frame);
    expect(tracker.counts('x').reReads).toBe(0);
    expect(files).toEqual(['/w/n.txt#[1,400]']);
  });
});

describe('context signals through the shell', () => {
  it('reads cat, head and sed -n as reads, each part on its own', () => {
    expect(shellReads('cat notes.txt')).toEqual([{ path: 'notes.txt', range: '' }]);
    expect(shellReads('sed -n 1,80p a.ts && sed -n 81,160p a.ts')).toEqual([{ path: 'a.ts', range: 'sed -n 1,80p' }, { path: 'a.ts', range: 'sed -n 81,160p' }]);
    expect(shellReads('head -n 50 a.ts | grep x')).toEqual([{ path: 'a.ts', range: 'head -n 50' }]);
    expect(shellReads('cat a > b')).toBeUndefined();
    expect(shellReads("sed -i 's/a/b/' a.ts")).toBeUndefined();
    expect(shellReads('npm test')).toBeUndefined();
  });

  it('counts a file cat-ed twice, relative or absolute, and not pages of it', () => {
    const files: string[] = [];
    const tracker = createSignalTracker(files, '/w');
    tracker.note(run('1', 'cat notes.txt'));
    tracker.note(read('2', '/w/notes.txt'));
    tracker.note(run('3', 'sed -n 1,100p big.ts'));
    tracker.note(run('4', 'sed -n 101,200p big.ts'));
    tracker.note(run('5', ['bash', '-lc', 'cat /w/notes.txt']));
    expect(tracker.counts('x').reReads).toBe(2);
  });

  it('forgets a file another command may have changed', () => {
    const files: string[] = [];
    const tracker = createSignalTracker(files, '/w');
    tracker.note(run('1', 'sed -n 1,50p a.ts'));
    tracker.note(run('2', "sed -i 's/x/y/' a.ts"));
    tracker.note(run('3', 'sed -n 1,50p a.ts'));
    tracker.note(run('4', 'cat b.ts'));
    tracker.note(run('5', 'npx prettier --write b.ts'));
    tracker.note(run('6', 'cat b.ts'));
    expect(tracker.counts('x').reReads).toBe(0);
  });
});
