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
