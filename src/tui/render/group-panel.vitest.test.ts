import { describe, expect, it } from 'vitest';
import type { ActivityEntry } from './activity-log.js';
import { groupPanelRows, type GroupPanelState } from './group-panel.js';
import { extractTags, parseTag } from './row-tags.js';
import type { GroupData } from './call-groups.js';

const strip = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');
const entry = (id: string, label: string, extra: Partial<NonNullable<ActivityEntry['event']>> = {}): ActivityEntry => ({
  anchor: 0, lines: [`‣ ${label}`], event: { kind: 'tool-done', label, category: 'run', id, ...extra },
});
const data = (entries: Array<[string, ActivityEntry]>): GroupData => ({ id: 'g', items: entries.map(([id, item]) => ({ id, entry: item })), running: false });
const state = (): GroupPanelState => ({ id: 'g', open: new Set() });
const plain = (rows: string[]): string[] => extractTags(rows).rows.map(strip);

describe('the expansion panel of a group', () => {
  const group = data([
    ['a', entry('a', '$ npm te…', { call: { name: 'Bash', input: { command: 'npm test -- --reporter verbose --bail' } }, output: ['ok 1', 'ok 2'], exitCode: 1 })],
    ['b', entry('b', 'Read a.ts', { category: 'read' })],
    ['t', { anchor: 0, lines: ['✻ Thought for 3s'], thought: { durationMs: 3000, text: 'Check the parser before the lexer.' }, event: { kind: 'thinking', label: 'x' } }],
  ]);

  it('lists the items one per row under a header that closes it', () => {
    const rows = groupPanelRows(group, state(), 80, 20);
    expect(plain(rows)).toEqual([
      '  ‣ Ran 2 commands · 1 thoughts · tap or Esc to close'.replace('1 thoughts', '1 thought').replace('Ran 2 commands', 'Ran 1 command, read 1 file'),
      '    ‣ $ npm te…', '    ‣ Read a.ts', '    ✻ Thought for 3s',
    ]);
    expect(parseTag(extractTags(rows).tags[0])).toEqual({ kind: 'gp', group: 'g', item: '' });
    expect(parseTag(extractTags(rows).tags[2])).toEqual({ kind: 'gp', group: 'g', item: 'b' });
  });

  it('opens a call to its full command wrapped, how it ended and its output; a second tap collapses it', () => {
    const open = state();
    open.open.add('a');
    const rows = plain(groupPanelRows(group, open, 40, 20));
    expect(rows.slice(2, 6)).toEqual(['      $ npm test -- --reporter verbose', '      --bail', expect.stringContaining('exit 1'), '      ok 1']);
    expect(rows).toContain('      ok 2');
    open.open.delete('a');
    expect(plain(groupPanelRows(group, open, 40, 20))).toHaveLength(4);
  });

  it('opens a thought to its text, and shows only the command where nothing else was kept', () => {
    const open = state();
    open.open.add('t');
    open.open.add('b');
    const rows = plain(groupPanelRows(group, open, 80, 20));
    expect(rows).toContain('      Check the parser before the lexer.');
    expect(rows[rows.indexOf('    ‣ Read a.ts') + 1]).toBe('      Read a.ts');
  });

  it('keeps to its height: the newest items, with the earlier ones counted and tappable', () => {
    const many = data(Array.from({ length: 12 }, (_, index) => [`i${index}`, entry(`i${index}`, `$ cmd ${index}`)] as [string, ActivityEntry]));
    const open = state();
    const rows = groupPanelRows(many, open, 80, 6);
    const text = plain(rows);
    expect(text).toHaveLength(6);
    expect(text[1]).toBe('    +8 earlier');
    expect(text[text.length - 1]).toBe('    ‣ $ cmd 11');
    expect(parseTag(extractTags(rows).tags[1])?.item).toBe('@earlier');
    // Paging back reaches the earliest.
    open.start = 0;
    const first = plain(groupPanelRows(many, open, 80, 6));
    expect(first[1]).toBe('    ‣ $ cmd 0');
    expect(first[first.length - 1]).toMatch(/more$/);
  });

  it('keeps an opened item in view when the group is taller than the panel', () => {
    const many = data(Array.from({ length: 12 }, (_, index) => [`i${index}`, entry(`i${index}`, `$ cmd ${index}`, { output: ['out'] })] as [string, ActivityEntry]));
    const open = state();
    open.open.add('i1');
    open.anchor = 'i1';
    const text = plain(groupPanelRows(many, open, 80, 6));
    expect(text).toContain('    ‣ $ cmd 1');
    expect(text).toContain('      out');
  });
});
