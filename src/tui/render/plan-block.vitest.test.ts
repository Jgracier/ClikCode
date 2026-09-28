import { describe, expect, it } from 'vitest';
import { planBlockRows } from './plan-block.js';

// eslint-disable-next-line no-control-regex
const plain = (row: string) => row.replace(/\u001b\[[0-9;]*m/g, '');
const entries = [
  { content: 'done step', status: 'completed' },
  { content: 'running step', status: 'in_progress' },
  { content: 'dropped step', status: 'cancelled' },
  { content: 'next step', status: 'pending' },
];

describe('the plan block', () => {
  it('marks each state, and animates the running step with the spinner while keeping every row aligned', () => {
    const idle = planBlockRows(entries, 60).map(plain);
    expect(idle).toEqual(['  ☑ done step', '  ◐ running step', '  ☒ dropped step', '  ☐ next step']);
    const animated = planBlockRows(entries, 60, 6, '⣾⣷').map(plain);
    expect(animated[1]).toBe(' ⣾⣷ running step');
    // The text of every row starts in the same column.
    expect(new Set(animated.map((row) => row.indexOf('step') - row.split(' ').slice(-2, -1)[0]!.length - 1)).size).toBe(1);
  });

  it('counts a cancelled step as settled when windowing a long plan', () => {
    const long = [
      ...Array.from({ length: 6 }, (_, i) => ({ content: `old ${i}`, status: i % 2 ? 'cancelled' : 'completed' })),
      { content: 'now', status: 'in_progress' },
      { content: 'later', status: 'pending' },
    ];
    const rows = planBlockRows(long, 60, 4).map(plain);
    expect(rows.some((row) => row.includes('now'))).toBe(true);
    expect(rows.at(-1)).toContain('6/8 done');
  });
});
