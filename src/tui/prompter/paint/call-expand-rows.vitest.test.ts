import { describe, expect, it, vi } from 'vitest';
import type { HarnessActivityEvent } from '../../../harness/prompter.js';
import type { SettlingTool } from '../../../turn/transcript.js';
import type { HarnessSession, TranscriptMessage } from '../../../session/model.js';
import { ActivityEntry, upsertActivityEvent } from '../../render/activity-log.js';
import { CallGrouping, GroupRegistry } from '../../render/call-groups.js';
import { extractTags, parseTag } from '../../render/row-tags.js';
import { GroupExpansion } from '../../render/group-rows.js';
import { tapGroupRow, toggleLatestGroup } from '../group-actions.js';
import { createRowBuilders, createToolRows, createTurnTools } from './rows.js';

const strip = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');

function kit(overrides: Record<string, unknown> = {}) {
  const p = {
    callGroups: new GroupRegistry(), groupExpansion: new GroupExpansion(), agentStarts: new Map(), liveChildren: { latest: () => undefined, rows: () => [] }, viewportRows: () => 30, reducedMotion: true, waitingFrame: 0,
    liveResponse: '', approvalQueue: [], childEntries: [] as ActivityEntry[], ...overrides,
  };
  const builders = createRowBuilders(p as never, 80);
  return { p, builders, rows: createToolRows(p as never, builders) };
}

const event = (id: string, kind: HarnessActivityEvent['kind'], label: string, extra: Partial<HarnessActivityEvent> = {}): HarnessActivityEvent => ({
  id, kind, label, category: 'run', ...extra,
});

function entriesOf(events: HarnessActivityEvent[], offset = 0): ActivityEntry[] {
  let entries: ActivityEntry[] = [];
  events.forEach((item, index) => { entries = upsertActivityEvent(entries, 0, offset, item, index + 1); });
  return entries;
}

const textOf = (tools: readonly SettlingTool[]): string[] => tools.flatMap((tool) => extractTags(tool.lines).rows.map(strip));

const AGENT = event('a1', 'tool-done', 'Agent explore the parser', {
  category: undefined, agent: true, childTools: 2, childTokens: 30000, durationMs: 65000,
  call: { name: 'Task', input: { description: 'explore the parser', prompt: 'Find where tokens are produced and report the file.' } },
  output: ['Tokens come from lexer.ts', 'Nothing else reads them'],
});
const CHILDREN = [
  event('c1', 'tool-done', 'Read lexer.ts', { category: 'read', parentId: 'a1' }),
  event('c2', 'tool-error', '$ grep -rn token src', { parentId: 'a1', output: ['grep: src: boom'] }),
];

describe('a sub-agent row, opened in place', () => {
  const live = (open: string[] = [], events: HarnessActivityEvent[] = [AGENT], ended = true) => {
    const k = kit();
    k.p.childEntries = entriesOf(CHILDREN);
    for (const item of open) {
      if (item === 'a1') k.p.groupExpansion.toggleGroup('call:a1');
      else k.p.groupExpansion.toggleItem('call:a1', item);
    }
    return { k, text: textOf(k.rows.groupedRows(entriesOf(events), ended, new CallGrouping())) };
  };

  it('is one row closed, with its outcome', () => {
    expect(live().text).toEqual(['', '  ‣ Agent explore the parser (2 tool uses · 30k tokens · 1m 5s)']);
  });

  it('opens to its task, each call it made, and what it answered', () => {
    expect(live(['a1']).text).toEqual([
      '', '  ‣ Agent explore the parser (2 tool uses · 30k tokens · 1m 5s)',
      '    Find where tokens are produced and report the file.',
      '      ‣ Read lexer.ts', '      ‣ $ grep -rn token src failed',
      '    Tokens come from lexer.ts', '    Nothing else reads them',
    ]);
  });

  it('opens a child call to its own detail, and minimises it again', () => {
    const text = live(['a1', 'c2']).text;
    expect(text.slice(4)).toEqual(['      ‣ $ grep -rn token src failed', '          $ grep -rn token src', '          grep: src: boom', '    Tokens come from lexer.ts', '    Nothing else reads them']);
    expect(live(['a1', 'c2', 'c2']).text).toEqual(live(['a1']).text);
  });

  it('shows what a running agent has done so far', () => {
    const running = { ...AGENT, kind: 'tool-start' as const, output: undefined, childTools: 1 };
    const { text } = live(['a1'], [running], false);
    expect(text.join('\n')).toContain('      ‣ Read lexer.ts');
    expect(text.join('\n')).not.toContain('Tokens come from');
  });

  it('shows the task and the answer only when no children were kept, and invents nothing', () => {
    const k = kit();
    k.p.groupExpansion.toggleGroup('call:a1');
    const text = textOf(k.rows.groupedRows(entriesOf([{ ...AGENT, childTools: 12 }]), true, new CallGrouping()));
    expect(text.slice(2)).toEqual([
      '    Find where tokens are produced and report the file.', '      +12 earlier', '    Tokens come from lexer.ts', '    Nothing else reads them',
    ]);
    const bare = kit();
    bare.p.groupExpansion.toggleGroup('call:b');
    expect(textOf(bare.rows.groupedRows(entriesOf([event('b', 'tool-done', 'Agent x', { agent: true, category: undefined })]), true, new CallGrouping()))).toEqual(['', '  ‣ Agent x']);
  });

  it('counts in the summary of a run it is part of, and stays its own tappable row', () => {
    const k = kit();
    const tools = k.rows.groupedRows(entriesOf([event('1', 'tool-done', '$ a'), event('2', 'tool-done', '$ b'), AGENT]), true, new CallGrouping());
    const rows = tools.flatMap((tool) => extractTags(tool.lines));
    const text = rows.flatMap((row) => row.rows.map(strip)).join('\n');
    expect(text).toContain('Ran 2 commands, 1 agent');
    expect(text).toContain('Agent explore the parser');
    const tagged = tools.flatMap((tool) => extractTags(tool.lines).tags).map(parseTag).filter(Boolean);
    expect(tagged.some((tag) => tag!.group === 'call:a1')).toBe(true);
  });

  it('is the same row reopened from the saved turn, children included', () => {
    const k = kit();
    k.p.groupExpansion.toggleGroup('call:a1');
    k.p.groupExpansion.toggleItem('call:a1', 'c2');
    const message: TranscriptMessage = {
      role: 'assistant', content: 'done',
      activities: [AGENT, ...CHILDREN].map((item) => ({ event: item, responseOffset: 0 })),
    };
    const { savedTools } = createTurnTools(k.p as never, k.builders, k.rows, undefined as HarnessSession['pendingTurn'], { materializedPendingTurn: false });
    expect(textOf(savedTools(message, 0))).toEqual(live(['a1', 'c2']).text);
  });

  it('lists the agent children by the agent they belong to', () => {
    const k = kit();
    k.p.groupExpansion.toggleGroup('call:a1');
    k.p.childEntries = entriesOf([{ ...CHILDREN[0]!, parentId: 'other' }]);
    expect(textOf(k.rows.groupedRows(entriesOf([AGENT]), true, new CallGrouping())).join('\n')).not.toContain('Read lexer.ts');
  });
});

describe('a lone call, opened in place', () => {
  const rowsFor = (events: HarnessActivityEvent[], open: string[] = [], setup?: (p: ReturnType<typeof kit>['p']) => void) => {
    const k = kit();
    for (const id of open) k.p.groupExpansion.toggleGroup(`call:${id}`);
    setup?.(k.p);
    return textOf(k.rows.groupedRows(entriesOf(events), true, new CallGrouping()));
  };
  const COMMAND = event('1', 'tool-done', '$ npm test -- --reporter verbose --bail', {
    call: { name: 'Bash', input: { command: 'npm test -- --reporter verbose --bail' } }, output: ['ok 1', 'ok 2'], exitCode: 0,
  });

  it('shows its full command and the tail of its output, and minimises again', () => {
    expect(rowsFor([COMMAND])).toHaveLength(2);
    const open = rowsFor([COMMAND], ['1']);
    expect(open.slice(2)).toEqual(['    $ npm test -- --reporter verbose --bail', '    ok 1', '    ok 2']);
    expect(rowsFor([COMMAND], ['1', '1'])).toHaveLength(2);
  });

  it('shows the arguments of a tool that is not a command', () => {
    const mcp = event('2', 'tool-done', 'github.search', { category: undefined, call: { name: 'mcp__github__search', input: { query: 'parser bug', limit: 5 } } });
    expect(rowsFor([mcp], ['2']).slice(2)).toEqual(['    github.search', '    query: parser bug', '    limit: 5']);
  });

  it('shows an edit as numbered hunks, capped, with the rest counted', () => {
    const lines = Array.from({ length: 50 }, (_, index) => ({ kind: 'added' as const, text: `line ${index}`, line: index + 1 }));
    const edit = event('3', 'tool-done', 'Edited a.ts', { category: 'edit', diff: [{ path: 'a.ts', lines, additions: 50, removals: 0 }] });
    const text = rowsFor([edit], ['3']);
    expect(text.join('\n')).toContain(' 1 + line 0');
    expect(text.join('\n')).toMatch(/… 20 more lines/);
    expect(text.join('\n')).not.toContain('line 49');
  });

  it('shows a failed call its full output', () => {
    const output = Array.from({ length: 40 }, (_, index) => `err ${index}`);
    const failed = event('4', 'tool-error', '$ make', { output });
    const closed = rowsFor([failed]);
    expect(closed.join('\n')).not.toContain('err 0');
    const open = rowsFor([failed], ['4']).join('\n');
    expect(open).toContain('err 0');
    expect(open).toContain('err 39');
  });

  it('shows an approved or refused call the request it had', () => {
    const k = kit();
    const entries = entriesOf([event('5', 'tool-done', '$ rm')]);
    entries[0] = { ...entries[0]!, decision: { kind: 'approved', row: '', suffix: ' · approved', detail: 'rm -rf build/ in /work' } };
    k.p.groupExpansion.toggleGroup('call:5');
    expect(textOf(k.rows.groupedRows(entries, true, new CallGrouping())).join('\n')).toContain('rm -rf build/ in /work');
  });

  it('does nothing for a row that is not a call (a thought, a note)', () => {
    const k = kit();
    const note: ActivityEntry = { anchor: 0, responseOffset: 0, sequence: 1, lines: ['Plan · 0/1 done'] };
    const tools = k.rows.groupedRows([note], true, new CallGrouping());
    expect(extractTags(tools.flatMap((tool) => tool.lines)).tags.every((tag) => tag === undefined)).toBe(true);
  });

  it('is the same rows live and reopened', () => {
    const open = (p: ReturnType<typeof kit>['p']): void => { p.groupExpansion.toggleGroup('call:1'); };
    const k = kit();
    open(k.p);
    const message: TranscriptMessage = { role: 'assistant', content: 'x', activities: [{ event: COMMAND, responseOffset: 0 }] };
    const { savedTools } = createTurnTools(k.p as never, k.builders, k.rows, undefined as HarnessSession['pendingTurn'], { materializedPendingTurn: false });
    expect(textOf(savedTools(message, 0))).toEqual(rowsFor([COMMAND], ['1']));
  });
});

describe('tags and taps of expandable rows', () => {
  function host(events: HarnessActivityEvent[], open: string[] = []) {
    const k = kit();
    k.p.childEntries = entriesOf(CHILDREN);
    for (const id of open) k.p.groupExpansion.toggleGroup(id);
    const transcript = extractTags(k.rows.groupedRows(entriesOf(events), true, new CallGrouping()).flatMap((tool) => tool.lines));
    const lineTags = new Map<number, string>();
    transcript.tags.forEach((tag, index) => { if (tag) lineTags.set(10 + index, tag); });
    const h = {
      ...k.p, alternateTrimmed: 10, alternateTranscript: transcript.rows, alternateAbove: 40, alternateScrollback: 0, viewExtra: { rows: [], tags: [] }, lineTags,
      emitted: { requestReseed: vi.fn() }, redrawSelection: vi.fn(), frameLayout: { live: [], tags: [] as Array<string | undefined> }, groupAnchor: undefined as unknown,
    };
    return { k, h, transcript };
  }

  it('tags a call row with its id and a child row one level in', () => {
    const { transcript } = host([AGENT], ['call:a1']);
    const tags = transcript.tags.map(parseTag);
    expect(tags[1]).toEqual({ group: 'call:a1', item: '' });
    expect(tags[3]).toEqual({ group: 'call:a1', item: 'c1', depth: 1 });
  });

  it('a tap on a lone call opens it, a tap on a child opens the child, a tap on nothing does nothing', () => {
    const { k, h } = host([AGENT, event('9', 'tool-done', '$ ls')]);
    expect(tapGroupRow.call(h as never, 10)).toBe(false);
    expect(tapGroupRow.call(h as never, 11)).toBe(true);
    expect(k.p.groupExpansion.isOpen('call:a1')).toBe(true);
    const open = host([AGENT], ['call:a1']);
    expect(tapGroupRow.call(open.h as never, 13)).toBe(true);
    expect(open.k.p.groupExpansion.get('call:a1').items.has('c1')).toBe(true);
    expect(open.h.emitted.requestReseed).toHaveBeenCalled();
  });

  it('Ctrl+O opens the latest lone call', () => {
    const { k, h } = host([AGENT, event('9', 'tool-done', '$ ls')]);
    expect(toggleLatestGroup.call(h as never)).toBe(true);
    expect(k.p.groupExpansion.isOpen('call:9')).toBe(true);
  });
});
