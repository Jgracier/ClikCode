import { describe, expect, it, vi } from 'vitest';
import type { HarnessActivityEvent } from '../../../harness/prompter.js';
import type { SettlingTool } from '../../../turn/transcript.js';
import { ActivityEntry, upsertActivityEvent } from '../../render/activity-log.js';
import { CallGrouping, GroupRegistry } from '../../render/call-groups.js';
import { extractTags } from '../../render/row-tags.js';
import { tapGroupRow, toggleGroupPanel } from '../group-panel-actions.js';
import { createRowBuilders, createToolRows } from './rows.js';

const strip = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');

function kit(overrides: Record<string, unknown> = {}) {
  const p = { callGroups: new GroupRegistry(), reducedMotion: true, waitingFrame: 0, liveResponse: '', approvalQueue: [], ...overrides };
  return { p, rows: createToolRows(p as never, createRowBuilders(p as never, 80)) };
}

const event = (id: string, kind: HarnessActivityEvent['kind'], label: string, extra: Partial<HarnessActivityEvent> = {}): HarnessActivityEvent => ({
  id, kind, label, category: 'run', ...extra,
});

/** Entries as the turn produces them: calls upserted, thoughts appended. */
function turn(spec: Array<HarnessActivityEvent | { thought: string }>, offset = 0): ActivityEntry[] {
  let entries: ActivityEntry[] = [];
  let sequence = 0;
  for (const item of spec) {
    sequence += 1;
    if ('thought' in item) {
      entries.push({ anchor: 0, responseOffset: offset, sequence, event: { kind: 'thinking', label: item.thought }, thought: { durationMs: 3000, text: item.thought }, lines: ['✻ Thought for 3s'] });
    } else entries = upsertActivityEvent(entries, 0, offset, item, sequence);
  }
  return entries;
}

const settled = (tools: readonly SettlingTool[]): string[][] => tools.filter((tool) => tool.done).map((tool) => extractTags(tool.lines).rows.map(strip));

const SPEC = [
  { thought: 'look first' },
  event('1', 'tool-done', '$ npm test', { output: ['ok'] }),
  event('2', 'tool-done', 'Read a.ts', { category: 'read' }),
  event('3', 'tool-done', 'Edit a.ts', { category: 'edit' }),
  { thought: 'then conclude' },
];

describe('a run of calls and thoughts, as rows', () => {
  it('settles as one summary row, and a reopened turn draws the same row', () => {
    const live = kit();
    const grouping = new CallGrouping();
    const running = turn([...SPEC.slice(0, 2), event('2', 'tool-start', 'Read a.ts', { category: 'read' })]);
    const heldRows = live.rows.groupedRows(running, false, grouping);
    expect(heldRows.every((tool) => !tool.done)).toBe(true);
    // The tail is the live row: a spinner-less group row with its newest items under it.
    live.p.liveResponse = 'prose';
    const liveSettled = live.rows.groupedRows(turn(SPEC), false, grouping);
    const reopened = kit().rows.groupedRows(turn(SPEC), true, new CallGrouping());
    expect(settled(liveSettled)).toEqual([['', '  ‣ Ran 1 command, read 1 file, edited 1 file · 2 thoughts · tap']]);
    expect(settled(reopened)).toEqual(settled(liveSettled));
  });

  it('leaves a single item exactly as it was', () => {
    const tools = kit().rows.groupedRows(turn([event('1', 'tool-done', '$ ls')]), true, new CallGrouping());
    expect(settled(tools)).toEqual([['', '  ‣ $ ls']]);
  });

  it('keeps a failed call as its own red row and counts it, and a stopped one too', () => {
    const entries = turn([
      event('1', 'tool-done', '$ a'), event('2', 'tool-error', '$ bad', { output: ['boom'] }), event('3', 'tool-done', '$ b'),
      event('4', 'tool-error', '$ sleep', { stopped: true }),
    ]);
    const rows = settled(kit().rows.groupedRows(entries, true, new CallGrouping())).map((lines) => lines.join('\n'));
    expect(rows[0]).toBe('\n  ‣ Ran 2 commands · 1 failed · 1 stopped · tap');
    expect(rows.join('\n')).toContain('$ bad failed');
    expect(rows.join('\n')).toContain('$ sleep stopped');
  });

  it('does not fold a call waiting on an approval, nor a sub-agent', () => {
    const entries = turn([
      event('1', 'tool-done', '$ a'), event('2', 'tool-done', '$ b'), event('3', 'tool-start', '$ rm -rf x'),
      event('4', 'tool-start', 'Task(explore)', { category: undefined, agent: true }),
    ]);
    const { p, rows } = kit({ pendingApproval: { callId: '3' } });
    const tools = rows.groupedRows(entries, false, new CallGrouping());
    const text = tools.map((tool) => extractTags(tool.lines).rows.map(strip).join('\n')).join('\n');
    expect(text).toContain('Ran 2 commands');
    expect(text).toContain('rm -rf x');
    expect(text).toContain('Task(explore)');
    expect(p.callGroups.latest()?.items).toHaveLength(4);
  });

  it('holds every item behind a group row until prose, then settles once', () => {
    const { p, rows } = kit();
    const grouping = new CallGrouping();
    const entries = turn([event('1', 'tool-done', '$ a'), event('2', 'tool-done', '$ b')]);
    expect(rows.groupedRows(entries, false, grouping).map((tool) => tool.done)).toEqual([false]);
    p.liveResponse = 'The answer';
    expect(rows.groupedRows(entries, false, grouping).map((tool) => tool.done)).toEqual([true]);
  });
});

describe('tapping a group', () => {
  it('opens the group a row belongs to, and the panel rows control it', () => {
    const { p, rows } = kit();
    const tools = rows.groupedRows(turn(SPEC), true, new CallGrouping());
    const transcript = extractTags(tools.flatMap((tool) => tool.lines));
    const lineTags = new Map<number, string>();
    transcript.tags.forEach((tag, index) => { if (tag) lineTags.set(10 + index, tag); });
    const redrawSelection = vi.fn();
    const host = { ...p, alternateTrimmed: 10, alternateTranscript: transcript.rows, lineTags, frameLayout: { live: [], tags: [] as Array<string | undefined> }, groupPanel: undefined as unknown, redrawSelection, closeGroupPanel() { this.groupPanel = undefined; return true; } };
    const summaryLine = 10 + transcript.rows.findIndex((row) => row.includes('Ran 1 command'));
    // The blank row above it opens nothing.
    expect(tapGroupRow.call(host as never, 10)).toBe(false);
    expect(tapGroupRow.call(host as never, summaryLine)).toBe(true);
    expect(host.groupPanel).toMatchObject({ id: expect.any(String) });
    // Tapping the summary again closes it.
    expect(tapGroupRow.call(host as never, summaryLine)).toBe(true);
    expect(host.groupPanel).toBeUndefined();
    // Ctrl+O opens the latest group, and again closes it.
    expect(toggleGroupPanel.call(host as never)).toBe(true);
    expect(host.groupPanel).toBeDefined();
    expect(toggleGroupPanel.call(host as never)).toBe(true);
    expect(host.groupPanel).toBeUndefined();
    expect(redrawSelection).toHaveBeenCalled();
  });

  it('opens a lone item expanded from its own row', () => {
    const { p, rows } = kit();
    const tools = rows.groupedRows(turn([event('1', 'tool-done', '$ ls', { output: ['a', 'b'] })]), true, new CallGrouping());
    const transcript = extractTags(tools.flatMap((tool) => tool.lines));
    const lineTags = new Map<number, string>();
    transcript.tags.forEach((tag, index) => { if (tag) lineTags.set(index, tag); });
    const host = { ...p, alternateTrimmed: 0, alternateTranscript: transcript.rows, lineTags, frameLayout: { live: [], tags: [] }, groupPanel: undefined as undefined | { open: Set<string> }, redrawSelection: vi.fn() };
    expect(tapGroupRow.call(host as never, transcript.rows.findIndex((row) => row.includes('$ ls')))).toBe(true);
    expect([...host.groupPanel!.open]).toEqual(['1']);
  });
});
