import { describe, expect, it } from 'vitest';
import { paletteRows, panelRows } from './footer-rows.js';

// eslint-disable-next-line no-control-regex
const plain = (row: string) => row.replace(/\u001b\[[0-9;]*m/g, '');

describe('the palette band', () => {
  const commands = [
    { label: '/model', detail: 'choose a model', value: '/model', group: 'Settings' },
    { label: '/effort', value: '/effort', group: 'Settings' },
    { label: '/exit', value: '/exit', group: 'Session' },
  ];

  it('is a rule, the list with its section rules, padding to its height, and the hint', () => {
    const rows = paletteRows(commands, 1, 8, 40).map(plain);
    expect(rows).toHaveLength(8);
    expect(rows[0]).toBe('─'.repeat(39));
    expect(rows.slice(1, 6)).toEqual(['  ── Settings', '    /model  choose a model', '  ❯ /effort', '  ── Session', '    /exit']);
    expect(rows[6]).toBe('');
    expect(rows[7]).toBe('  ↑↓ select · Tab complete · Enter run');
  });

  it('reads sections as headings in a picker, from the edge, with its own hint', () => {
    const rows = paletteRows([{ label: 'one', value: 'a', group: 'Running 2' }], 0, 4, 40, { headings: true, hint: 'Esc exit' }).map(plain);
    expect(rows).toEqual(['─'.repeat(39), 'Running 2', '❯ one', 'Esc exit']);
  });

  it('drops a detail that has no room rather than squeezing it', () => {
    const [, row] = paletteRows([{ label: 'a-very-long-label', detail: 'detail', value: 'x' }], 0, 3, 24).map(plain);
    expect(row).toBe('  ❯ a-very-long-label');
  });
});

describe('the panel band', () => {
  const body = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);

  it('shows a page of the body and where it is, clamping the offset to the last page', () => {
    const shown = panelRows({ title: 'Help', lines: body, offset: 50 }, 40, 7, 40);
    expect(shown).toMatchObject({ page: 5, total: 20, offset: 15 });
    expect(shown.rows.map(plain)).toEqual([
      '  Help', '  line 16', '  line 17', '  line 18', '  line 19', '  line 20',
      '  16-20 of 20 · ↑↓ PgUp/PgDn scroll · q/E…',
    ]);
  });

  it('says only how to close a body that fits, and wraps lines wider than the band', () => {
    const shown = panelRows({ title: 'T', lines: ['x'.repeat(15)], offset: 0 }, 10, 10, 40);
    expect(shown.total).toBe(2);
    expect(shown.rows.map(plain)).toEqual(['  T', `  ${'x'.repeat(10)}`, '  xxxxx', '  q/Esc/Ent…']);
  });

  it('breaks prose between words, keeping the line\'s indent', () => {
    const shown = panelRows({ title: 'T', lines: ['  alpha beta gamma'], offset: 0 }, 10, 10, 40);
    expect(shown.rows.map(plain).slice(1, -1)).toEqual(['    alpha', '    beta', '    gamma']);
  });
});
