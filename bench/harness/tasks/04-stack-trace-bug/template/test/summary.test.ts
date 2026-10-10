import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderReport, summarize } from '../src/report/summary.ts';

const tickets = [
  { id: 'T-1', title: 'Login fails', tags: ['auth', 'urgent'], openedAt: '2026-01-02' },
  { id: 'T-2', title: 'Typo', tags: [], openedAt: '2026-01-03' },
  { id: 'T-3', title: 'Slow search page', tags: ['perf'], openedAt: '2026-01-04' },
];

test('counts tags and untagged tickets', () => {
  const summary = summarize(tickets);
  assert.equal(summary.total, 3);
  assert.equal(summary.untagged, 1);
  assert.deepEqual(summary.byTag, { auth: 1, urgent: 1, perf: 1 });
  assert.equal(summary.longestTitle, 16);
});

test('renders a report', () => {
  assert.match(renderReport(tickets), /Untagged: 1/);
});
