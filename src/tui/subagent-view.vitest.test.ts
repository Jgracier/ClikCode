import { describe, expect, it } from 'vitest';
import { subAgentRefs, subAgentViewKey, subAgentViewLines, subAgentViewOpen } from './subagent-view.js';
import type { SubAgentRow } from '../harness/subagent-read.js';

const strip = (line: string): string => line.replace(/\u001b\[[0-9;]*m/g, '');
const relay = { read: 'transcript', steer: 'relay' } as const;
const events = [
  { kind: 'tool-start', label: 'Agent explore', agent: true, id: 'a1' },
  { kind: 'tool-start', label: 'Agent review', agent: true, id: 'a2' },
  { kind: 'tool-start', label: '$ ls', id: 'c1', parentId: 'a1' },
  { kind: 'tool-done', label: 'tool', agent: true, id: 'a2' },
] as const;
const refs = subAgentRefs(events as never, 'claude', relay);

describe('subAgentRefs', () => {
  it('makes one ref per agent row, in order, with its latest state; children are not agents', () => {
    expect(refs.map((r) => [r.id, r.label, r.status])).toEqual([['a1', 'Agent explore', 'running'], ['a2', 'Agent review', 'done']]);
  });
});

describe('subAgentViewKey', () => {
  const open = subAgentViewOpen(refs, 'a1')!;
  it('Left on an empty composer, Esc and Ctrl+C go back, and nothing stops the main turn', () => {
    for (const key of ['\u001b[D', '\u001b', '\u0003']) expect(subAgentViewKey(open, key, 'Claude Code')).toEqual({ type: 'back' });
  });
  it('Up and Down move between siblings and stop at the ends', () => {
    expect(subAgentViewKey(open, '\u001b[A', 'V')).toEqual({ type: 'none' });
    const down = subAgentViewKey(open, '\u001b[B', 'V');
    expect(down).toMatchObject({ type: 'open', state: { index: 1 } });
    expect(subAgentViewKey((down as { state: typeof open }).state, '\u001b[B', 'V')).toEqual({ type: 'none' });
  });
  it('types, edits and sends; Left with a draft moves the cursor instead of leaving', () => {
    let state = open;
    for (const key of ['h', 'i']) state = (subAgentViewKey(state, key, 'V') as { state: typeof open }).state;
    expect(state.draft).toBe('hi');
    state = (subAgentViewKey(state, '\u001b[D', 'V') as { state: typeof open }).state;
    expect(state.cursor).toBe(1);
    const sent = subAgentViewKey(state, '\r', 'V');
    expect(sent).toMatchObject({ type: 'send', text: 'hi', ref: { id: 'a1' }, state: { draft: '' } });
  });
  it('ignores typing in a read-only or finished view but still navigates', () => {
    const readOnly = subAgentViewOpen(subAgentRefs(events as never, 'codex', { read: 'thread', steer: 'none' }), 'a1')!;
    expect(subAgentViewKey(readOnly, 'x', 'Codex')).toEqual({ type: 'none' });
    expect(subAgentViewKey(readOnly, '\u001b[B', 'Codex')).toMatchObject({ type: 'open' });
    const done = subAgentViewOpen(refs, 'a2')!;
    expect(subAgentViewKey(done, 'x', 'V')).toEqual({ type: 'none' });
  });
  it('lets no control byte into the draft', () => {
    expect(subAgentViewKey(subAgentViewOpen(refs, 'a1')!, '\u001b[200~', 'V')).toEqual({ type: 'none' });
  });
});

describe('subAgentViewLines', () => {
  const rows: SubAgentRow[] = [
    { kind: 'prompt', text: 'Find the parser' },
    { kind: 'activity', event: { kind: 'tool-done', label: '$ ls', id: 'c1' } },
    { kind: 'text', text: 'Found it.' },
  ];
  it('draws a header, the rows like a chat, a composer and the main turn status', () => {
    const lines = subAgentViewLines(subAgentViewOpen(refs, 'a1')!, { vendor: 'Claude Code', mainStatus: 'main: running 3m', rows, width: 80 }).map(strip);
    expect(lines[0]).toMatch(/^main > .+ Agent explore$/);
    expect(lines).toContain('› Find the parser');
    expect(lines.some((l) => l.includes('$ ls'))).toBe(true);
    expect(lines).toContain('Found it.');
    expect(lines.at(-2)).toBe('› ');
    expect(lines.at(-1)).toContain('main: running 3m');
    expect(lines.at(-1)).toContain('(1/2)');
  });
  it('says exactly why a view is read-only, in place of the composer', () => {
    const state = subAgentViewOpen(subAgentRefs(events as never, 'codex', { read: 'thread', steer: 'none' }), 'a1')!;
    const lines = subAgentViewLines(state, { vendor: 'Codex', mainStatus: 'main: running 1m', rows: [], width: 100 }).map(strip);
    expect(lines.at(-2)).toBe('Codex gives ClikCode no way to message a running sub-agent: this view is read-only.');
  });
  it('strips terminal escapes from what the sub-agent said', () => {
    const lines = subAgentViewLines(subAgentViewOpen(refs, 'a1')!, { vendor: 'V', mainStatus: 'm', rows: [{ kind: 'text', text: 'a\u001b]52;c;eA==\u0007b' }], width: 80 });
    expect(lines.join('\n')).not.toContain('\u001b]52');
  });
});

describe('what a sub-agent did, shown under each call', () => {
  const call = (id: string, command: string, output: string[], kind: 'tool-start' | 'tool-done' = 'tool-done'): SubAgentRow => ({
    kind: 'activity',
    event: { kind, label: `$ ${command}`, id, category: 'run', call: { name: 'Bash', input: { command } }, ...(output.length ? { output } : {}) } as never,
  });
  const thought: SubAgentRow = { kind: 'activity', event: { kind: 'thinking', label: 'Weighing the retry', id: 't1' } as never, thought: 'The retry lives in the client, so the fix belongs there and not in the caller.' };
  const rows: SubAgentRow[] = [
    { kind: 'prompt', text: 'Find why the deploy stalls' },
    call('old1', 'grep -rn "stall" src/deploy', ['src/deploy/a.ts:12: stall'], 'tool-done'),
    call('old2', 'cat src/deploy/a.ts', ['line one']),
    call('old3', 'git log --oneline -5', ['abc123 fix']),
    call('old4', 'ls -la', ['total 0']),
    thought,
    call('new1', 'pnpm vitest run src/deploy --reporter=dot', ['PASS 12 tests', 'FAIL 1 test: retries once']),
    call('run1', 'tail -f /var/log/deploy.log', ['starting…'], 'tool-start'),
  ];
  const state = subAgentViewOpen(refs, 'a1')!;
  const shown = (detail: 'recent' | 'all' | 'lines'): string[] => subAgentViewLines({ ...state, detail }, { vendor: 'Claude Code', mainStatus: 'main: running', rows, width: 100 }).map(strip);

  it('opens the newest calls with the whole command and what came back, the thought whole, and the one still running', () => {
    const text = shown('recent').join('\n');
    expect(text).toContain('pnpm vitest run src/deploy --reporter=dot');
    expect(text).toContain('FAIL 1 test: retries once');
    expect(text).toContain('The retry lives in the client');
    expect(text).toContain('tail -f /var/log/deploy.log');
    // The oldest are one line each: their output is not under them.
    expect(text).not.toContain('src/deploy/a.ts:12: stall');
  });

  it('all opens every call, lines opens none, and Tab goes round them', () => {
    expect(shown('all').join('\n')).toContain('src/deploy/a.ts:12: stall');
    const lines = shown('lines').join('\n');
    expect(lines).not.toContain('FAIL 1 test: retries once');
    expect(lines).not.toContain('The retry lives in the client');
    let next = state;
    const seen: string[] = [];
    for (let step = 0; step < 3; step += 1) {
      next = (subAgentViewKey(next, '\t', 'V') as { state: typeof state }).state;
      seen.push(next.detail);
    }
    expect(seen).toEqual(['all', 'lines', 'recent']);
    // Typing a Tab does not put one in the draft.
    expect(next.draft).toBe('');
  });

  it('says in its last line how much is open', () => {
    expect(shown('recent').at(-1)).toContain('tab: recent calls open');
    expect(shown('all').at(-1)).toContain('tab: all calls open');
    expect(shown('lines').at(-1)).toContain('tab: one line each');
  });
});
