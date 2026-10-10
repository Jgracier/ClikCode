import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ticketLine } from '../src/report/format.ts';
import { renderReport, summarize } from '../src/report/summary.ts';

const legacy = { id: 'OLD-3307', title: 'Migrate legacy invoices', openedAt: '2019-03-14' };
const tickets = [{ id: 'T-9001', title: 'Export button greyed out', tags: ['ui'], openedAt: '2026-10-07' }, legacy, { id: 'T-2', title: 'x', tags: [], openedAt: '2026-01-03' }];

test('hidden: summarize counts a ticket without tags as untagged', () => {
  const summary = summarize(tickets);
  assert.equal(summary.total, 3);
  assert.equal(summary.untagged, 2);
  assert.deepEqual(summary.byTag, { ui: 1 });
});

test('hidden: the line for a legacy ticket renders', () => {
  assert.match(ticketLine(legacy, 30), /^OLD-3307/);
});

test('hidden: the whole report renders, end to end', () => {
  assert.match(renderReport(tickets), /Untagged: 2/);
  const dir = mkdtempSync(join(tmpdir(), 'bench-tickets-'));
  try {
    const file = join(dir, 't.jsonl');
    writeFileSync(file, tickets.map((ticket) => JSON.stringify(ticket)).join('\n'));
    const run = spawnSync('node', ['src/cli.ts', file], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /OLD-3307/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
