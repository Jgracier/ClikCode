/** An edit is a row per file with what it added and removed; the hunks are /diff. */
import { expect, it } from 'vitest';
import { renderActivityLine } from './activity-line.js';
import { eventDiff, unifiedEventDiff } from '../../agent/line-diff.js';

const plain = (rows: string[]) => rows.map((row) => row.replace(/\u001b\[[0-9;]*m/g, '').trimEnd());

it('shows an edit as one row, with its counts and no hunks', () => {
  const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
  const after = before.replace('line 5', 'line five').replace('line 20', 'line twenty');
  const rows = plain(renderActivityLine({ kind: 'tool-done', label: 'src/app.ts', category: 'edit', diff: eventDiff(before, after, { path: 'src/app.ts', numbered: true }) }));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatch(/src\/app\.ts \+2 -2$/);
});

it('names each file of a multi-file change, with what each added and removed', () => {
  const update = unifiedEventDiff('@@ -10,2 +10,2 @@\n-old b\n+new b\n context c\n', { path: 'a.ts' });
  const added = unifiedEventDiff('export const x = 1;\n', { path: 'b.ts', change: 'add' });
  const rows = plain(renderActivityLine({ kind: 'tool-done', label: 'a.ts, b.ts', category: 'edit', diff: [...update, ...added] }));
  expect(rows).toEqual(['  ‣ Edited a.ts +1 -1', '  ‣ Created b.ts +1']);
});
