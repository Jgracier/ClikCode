/** An edit's row: hunks with line numbers where they are real, every file. */
import { expect, it } from 'vitest';
import { renderActivityLine } from './activity-line.js';
import { eventDiff, unifiedEventDiff } from '../../agent/line-diff.js';

const plain = (rows: string[]) => rows.map((row) => row.replace(/\u001b\[[0-9;]*m/g, '').trimEnd());

it('shows a whole-file edit as numbered hunks with context, the gap between them marked', () => {
  const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
  const after = before.replace('line 5', 'line five').replace('line 20', 'line twenty');
  const rows = plain(renderActivityLine({ kind: 'tool-done', label: 'src/app.ts', category: 'edit', diff: eventDiff(before, after, { path: 'src/app.ts', numbered: true }) }));
  expect(rows[0]).toMatch(/src\/app\.ts \+2 -2$/);
  expect(rows.slice(1)).toEqual([
    '     3   line 3', '     4   line 4', '     5 - line 5', '     5 + line five', '     6   line 6', '     7   line 7',
    '       ⋮',
    '    18   line 18', '    19   line 19', '    20 - line 20', '    20 + line twenty', '    21   line 21',
    '    … 1 more line',
  ]);
});

it('names each file of a multi-file change, with what each added and removed', () => {
  const update = unifiedEventDiff('@@ -10,2 +10,2 @@\n-old b\n+new b\n context c\n', { path: 'a.ts' });
  const added = unifiedEventDiff('export const x = 1;\n', { path: 'b.ts', change: 'add' });
  const rows = plain(renderActivityLine({ kind: 'tool-done', label: 'a.ts, b.ts', category: 'edit', diff: [...update, ...added] }));
  expect(rows).toEqual([
    expect.stringMatching(/a\.ts, b\.ts \+2 -1$/),
    '    a.ts +1 -1', '    10 - old b', '    10 + new b', '    11   context c',
    '    b.ts (new) +1', '     1 + export const x = 1;',
  ]);
});

it("shows a fragment's change without line numbers it does not have", () => {
  const rows = plain(renderActivityLine({ kind: 'tool-done', label: 'x.ts', category: 'edit', diff: eventDiff('a = 1', 'a = 2', { path: 'x.ts' }) }));
  expect(rows.slice(1)).toEqual(['    - a = 1', '    + a = 2']);
});
