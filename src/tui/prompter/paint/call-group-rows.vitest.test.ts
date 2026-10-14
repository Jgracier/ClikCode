import { describe, expect, it, vi } from 'vitest';
import type { HarnessActivityEvent } from '../../../harness/prompter.js';
import type { SettlingTool } from '../../../turn/transcript.js';
import { ActivityEntry, upsertActivityEvent } from '../../render/activity-log.js';
import { CallGrouping, GroupRegistry } from '../../render/call-groups.js';
import { extractTags, parseTag } from '../../render/row-tags.js';
import { GroupExpansion } from '../../render/group-rows.js';
import { anchoredScrollback, screenRowOfLine, tapGroupRow, toggleLatestGroup } from '../group-actions.js';
import { createRowBuilders, createToolRows } from './rows.js';

const strip = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');

function kit(overrides: Record<string, unknown> = {}) {
  const p = { callGroups: new GroupRegistry(), groupExpansion: new GroupExpansion(), viewportRows: () => 30, reducedMotion: true, waitingFrame: 0, liveResponse: '', approvalQueue: [], ...overrides };
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
    expect(p.callGroups.latest()?.items).toHaveLength(2);
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


const textOf = (tools: readonly SettlingTool[]): string[] => tools.filter((tool) => tool.done).flatMap((tool) => extractTags(tool.lines).rows.map(strip));
const SPEC_OPEN = [
  event('1', 'tool-done', '$ npm test', { call: { name: 'Bash', input: { command: 'npm test -- --reporter verbose' } }, output: ['ok 1', 'ok 2'], exitCode: 1 }),
  event('2', 'tool-done', 'Read a.ts', { category: 'read' }),
  { thought: 'Check the parser first.' },
];

describe('a group opened in place', () => {
  const build = (setup: (p: ReturnType<typeof kit>['p']) => void, ended = true) => {
    const k = kit();
    setup(k.p);
    return textOf(k.rows.groupedRows(turn(SPEC_OPEN), ended, new CallGrouping()));
  };
  const gid = '1';

  it('is one summary row closed, the items under the header open, and the item detail under its own row', () => {
    expect(build(() => {})).toEqual(['', '  ‣ Ran 1 command, read 1 file · 1 thought · tap']);
    const open = build((p) => p.groupExpansion.toggleGroup(gid));
    expect(open).toEqual([
      '', '  ‣ Ran 1 command, read 1 file · 1 thought · tap to collapse',
      '    ‣ $ npm test (exit 1)', '    ‣ Read a.ts', '    ✻ Thought for 3s',
    ]);
    const itemOpen = build((p) => { p.groupExpansion.toggleGroup(gid); p.groupExpansion.toggleItem(gid, '1'); p.groupExpansion.toggleItem(gid, 'thought:2'); });
    expect(itemOpen.slice(0, 4)).toEqual([open[0], open[1], open[2], '        $ npm test -- --reporter verbose']);
    expect(itemOpen.some((row) => row.includes('exit 1'))).toBe(true);
    expect(itemOpen).toContain('        ok 2');
    expect(itemOpen[itemOpen.length - 1]).toBe('        Check the parser first.');
  });

  it('minimises again when toggled', () => {
    const k = kit();
    k.p.groupExpansion.toggleGroup(gid);
    k.p.groupExpansion.toggleGroup(gid);
    expect(textOf(k.rows.groupedRows(turn(SPEC_OPEN), true, new CallGrouping()))).toHaveLength(2);
  });

  it('draws the same rows live (settled by prose) and reopened', () => {
    const open = (p: ReturnType<typeof kit>['p']): void => { p.groupExpansion.toggleGroup(gid); p.groupExpansion.toggleItem(gid, '1'); };
    const live = kit();
    open(live.p);
    live.p.liveResponse = 'prose';
    const liveRows = textOf(live.rows.groupedRows(turn(SPEC_OPEN), false, new CallGrouping()));
    expect(liveRows.length).toBeGreaterThan(5);
    expect(build(open)).toEqual(liveRows);
  });

  it('lists every item under the live header while running, bounded by the viewport', () => {
    const many = Array.from({ length: 12 }, (_, index) => event(`c${index}`, index === 11 ? 'tool-start' : 'tool-done', `$ cmd ${index}`));
    const k = kit({ viewportRows: () => 10 });
    const entries = turn(many);
    const closed = k.rows.groupedRows(entries, false, new CallGrouping());
    expect(closed[0]!.lines.length).toBe(5);
    k.p.groupExpansion.toggleGroup('c0');
    const open = k.rows.groupedRows(entries, false, new CallGrouping())[0]!;
    const text = extractTags(open.lines).rows.map(strip);
    expect(open.done).toBe(false);
    expect(text).toHaveLength(1 + Math.max(4, 10 - 8));
    expect(text.join('\n')).toMatch(/\+\d+ earlier/);
    expect(text[text.length - 1]).toContain('cmd 11');
    const roomy = kit({ viewportRows: () => 40 });
    roomy.p.groupExpansion.toggleGroup('c0');
    expect(extractTags(roomy.rows.groupedRows(entries, false, new CallGrouping())[0]!.lines).rows).toHaveLength(14);
  });

  it('tags the header, every item row and its detail, and none of the text', () => {
    const k = kit();
    k.p.groupExpansion.toggleGroup(gid);
    k.p.groupExpansion.toggleItem(gid, '1');
    const { tags, rows } = extractTags(k.rows.groupedRows(turn(SPEC_OPEN), true, new CallGrouping()).flatMap((tool) => tool.lines));
    expect(tags[0]).toBeUndefined();
    expect(tags.slice(1).every((tag) => tag !== undefined)).toBe(true);
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.join('').includes('\uE000')).toBe(false);
    expect(parseTag(tags[1])).toEqual({ group: gid, item: '' });
    expect(parseTag(tags[2])).toEqual({ group: gid, item: '1' });
  });
});

describe('tapping and Ctrl+O', () => {
  function host(open = false) {
    const k = kit();
    if (open) k.p.groupExpansion.toggleGroup('1');
    const tools = k.rows.groupedRows(turn(SPEC_OPEN), true, new CallGrouping());
    const transcript = extractTags(tools.flatMap((tool) => tool.lines));
    const lineTags = new Map<number, string>();
    transcript.tags.forEach((tag, index) => { if (tag) lineTags.set(10 + index, tag); });
    const emitted = { requestReseed: vi.fn() };
    const redrawSelection = vi.fn();
    const h = {
      ...k.p, alternateTrimmed: 10, alternateTranscript: transcript.rows, alternateAbove: 40, alternateScrollback: 0, lineTags, emitted, redrawSelection,
      frameLayout: { live: [], tags: [] as Array<string | undefined> }, groupAnchor: undefined as unknown,
    };
    return { h, transcript, emitted, redrawSelection };
  }

  it('toggles the group from its header, an item from its row, and rewrites the transcript', () => {
    const { h, transcript, emitted, redrawSelection } = host();
    const header = 10 + transcript.rows.findIndex((row) => row.includes('Ran 1 command'));
    expect(tapGroupRow.call(h as never, 10)).toBe(false);
    expect(tapGroupRow.call(h as never, header)).toBe(true);
    expect(h.groupExpansion.isOpen('1')).toBe(true);
    expect(emitted.requestReseed).toHaveBeenCalledTimes(1);
    expect(redrawSelection).toHaveBeenCalled();
    expect(tapGroupRow.call(h as never, header)).toBe(true);
    expect(h.groupExpansion.isOpen('1')).toBe(false);
    // The transcript as it is drawn once open: an item row toggles its item.
    const opened = host(true);
    const first = 10 + opened.transcript.rows.findIndex((row) => row.includes('$ npm test'));
    expect(tapGroupRow.call(opened.h as never, first)).toBe(true);
    expect([...opened.h.groupExpansion.get('1').items]).toEqual(['1']);
  });

  it('Ctrl+O toggles the latest group', () => {
    const { h } = host();
    expect(toggleLatestGroup.call(h as never)).toBe(true);
    expect(h.groupExpansion.isOpen('1')).toBe(true);
    expect(toggleLatestGroup.call(h as never)).toBe(true);
    expect(h.groupExpansion.isOpen('1')).toBe(false);
    expect(toggleLatestGroup.call({ ...h, callGroups: new GroupRegistry() } as never)).toBe(false);
  });

  it('asks for the tapped row to stay where it was, and for nothing when it is the last thing at the bottom', () => {
    // Two lines after the group, so it is not the last thing.
    const { h, transcript } = host();
    const header = 10 + transcript.rows.findIndex((row) => row.includes('Ran 1 command'));
    h.alternateTranscript.push('after', 'more');
    h.alternateScrollback = 3;
    // length 5 total: row of header = idx - (length - above - scrollback)
    tapGroupRow.call(h as never, header);
    expect(h.groupAnchor).toMatchObject({ group: '1', item: '', fit: true });
    const second = host();
    tapGroupRow.call(second.h as never, 10 + second.transcript.rows.findIndex((row) => row.includes('Ran 1 command')));
    expect(second.h.groupAnchor).toBeUndefined();
  });
});

describe('anchoring the viewport on the tapped row', () => {
  const lines = (count: number): string[] => Array.from({ length: count }, (_, index) => `row ${index}`);
  /** The transcript rows a screen shows, as flushAlternateFrame draws them. */
  const screen = (rows: readonly string[], above: number, scrollback: number): string[] => rows.slice(Math.max(0, rows.length - above - scrollback), rows.length - scrollback);

  it('keeps the row on the screen row it was on when the rows below it grow', () => {
    const above = 20;
    const before = lines(100);
    const scrollback = 30;
    const row = 7;
    const tappedIndex = before.length - above - scrollback + row;
    expect(screen(before, above, scrollback)[row]).toBe(`row ${tappedIndex}`);
    // The group opens: six rows are added under the tapped one.
    const after = [...before.slice(0, tappedIndex + 1), ...Array.from({ length: 6 }, (_, index) => `item ${index}`), ...before.slice(tappedIndex + 1)];
    const anchored = anchoredScrollback({ line: 500 + tappedIndex, height: 7, row, fit: true }, { length: after.length, trimmed: 500, above })!;
    expect(screen(after, above, anchored)[row]).toBe(`row ${tappedIndex}`);
    // The screen row seen from the prompter's own arithmetic agrees.
    expect(screenRowOfLine({ alternateTranscript: after, alternateTrimmed: 500, alternateAbove: above, alternateScrollback: anchored } as never, 500 + tappedIndex)).toBe(row);
  });

  it('moves a row near the bottom up just enough for what opens under it, and no further than the top', () => {
    const above = 20;
    const rows = lines(90);
    const index = 70;
    const target = { line: index, height: 12, row: 17, fit: true };
    const scrollback = anchoredScrollback(target, { length: rows.length, trimmed: 0, above })!;
    const shown = screen(rows, above, scrollback);
    expect(shown.indexOf('row 70')).toBe(8);
    expect(shown.slice(8)).toEqual(rows.slice(70, 82));
    // Taller than the screen: the row is at the top.
    const tall = anchoredScrollback({ ...target, height: 50 }, { length: rows.length, trimmed: 0, above })!;
    expect(screen(rows, above, tall)[0]).toBe('row 70');
  });

  it('follows the bottom when the row cannot be kept in a short transcript, and ignores a line that is gone', () => {
    expect(anchoredScrollback({ line: 3, height: 1, row: 10, fit: false }, { length: 8, trimmed: 0, above: 20 })).toBe(0);
    expect(anchoredScrollback({ line: 3, height: 1, row: 10, fit: false }, { length: 8, trimmed: 5, above: 20 })).toBeUndefined();
  });
});
