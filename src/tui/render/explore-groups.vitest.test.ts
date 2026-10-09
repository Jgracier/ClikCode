import { describe, expect, it } from 'vitest';
import type { HarnessActivityEvent } from '../../harness/prompter.js';
import { ExploreGrouping, mergedExploreLines } from './explore-groups.js';

const strip = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');
const read = (key: string, kind: HarnessActivityEvent['kind'] = 'tool-done', offset = 10) => ({
  key, responseOffset: offset, event: { kind, label: `Read ${key}.ts`, category: 'read' as const, id: key },
});
const grep = (key: string, kind: HarnessActivityEvent['kind'] = 'tool-done', offset = 10) => ({
  key, responseOffset: offset, event: { kind, label: `Grep ${key}`, category: 'search' as const, id: key, output: ['a:1', 'b:2'] },
});
const run = (key: string, kind: HarnessActivityEvent['kind'] = 'tool-done', offset = 10) => ({
  key, responseOffset: offset, event: { kind, label: '$ npm test', category: 'run' as const, id: key },
});
const shape = (groups: ReturnType<ExploreGrouping['group']>) => groups.map((group) => [group.members.map((member) => member.key).join('+'), group.merged, group.done]);

describe('a turn\'s reads and searches, merged while they happen', () => {
  it('holds a finished read open while it is the tail, so the next can join it', () => {
    const grouping = new ExploreGrouping();
    expect(shape(grouping.group([read('a')], false, 10))).toEqual([['a', false, false]]);
    expect(shape(grouping.group([read('a'), grep('b', 'tool-start')], false, 10))).toEqual([['a+b', true, false]]);
    expect(shape(grouping.group([read('a'), grep('b')], false, 10))).toEqual([['a+b', true, false]]);
    // Another kind of call follows: the merged row is settled, and sealed.
    expect(shape(grouping.group([read('a'), grep('b'), run('c', 'tool-start')], false, 10))).toEqual([['a+b', true, true], ['c', false, false]]);
    expect(shape(grouping.group([read('a'), grep('b'), run('c'), read('d')], false, 10))).toEqual([['a+b', true, true], ['c', false, true], ['d', false, false]]);
  });

  it('settles a run once prose follows it, and a later read starts its own row', () => {
    const grouping = new ExploreGrouping();
    expect(shape(grouping.group([read('a'), read('b')], false, 10))).toEqual([['a+b', true, false]]);
    expect(shape(grouping.group([read('a'), read('b')], false, 40))).toEqual([['a+b', true, true]]);
    // Even at the same offset (a replacement stream can move one back), a
    // sealed row takes no more members: it is already in scrollback.
    expect(shape(grouping.group([read('a'), read('b'), read('c')], false, 40))).toEqual([['a+b', true, true], ['c', false, true]]);
    const after = new ExploreGrouping();
    after.group([read('a'), read('b')], false, 40);
    expect(shape(after.group([read('a'), read('b'), read('c', 'tool-done', 40)], false, 40))).toEqual([['a+b', true, true], ['c', false, false]]);
  });

  it('never merges across prose, and settles everything when the turn ends', () => {
    const grouping = new ExploreGrouping();
    expect(shape(grouping.group([read('a', 'tool-done', 0), read('b', 'tool-start', 12)], false, 12))).toEqual([['a', false, true], ['b', false, false]]);
    expect(shape(grouping.group([read('a', 'tool-done', 0), read('b', 'tool-start', 12)], true, 12))).toEqual([['a', false, true], ['b', false, true]]);
  });

  it('keeps a member that failed in the row it joined', () => {
    const grouping = new ExploreGrouping();
    grouping.group([read('a'), read('b', 'tool-start')], false, 10);
    expect(shape(grouping.group([read('a'), read('b', 'tool-error')], false, 10))).toEqual([['a+b', true, false]]);
  });

  it('words the merged row as Claude Code does, the last calls under it as Cursor does', () => {
    const events = [read('a').event, { ...read('b').event, output: ['x', 'y'], outputOmitted: 40 }, grep('c').event, read('d', 'tool-start').event];
    const live = mergedExploreLines(events, false);
    expect(live.running).toBe(true);
    expect(live.summary).toBe('Reading 3 files, searching 1 pattern');
    expect(live.calls.map(strip)).toEqual(['Read b.ts · 42 lines', 'Searched c · 2 matches', 'Reading d.ts']);
    const ended = mergedExploreLines(events, true);
    expect(ended.running).toBe(false);
    expect(ended.summary).toBe('Read 3 files, searched 1 pattern');
  });

  it('says a member its turn was stopped under stopped, not failed', () => {
    const stopped = mergedExploreLines([read('a').event, { ...read('b', 'tool-error').event, stopped: true }], true);
    expect(stopped.calls.map(strip)).toEqual(['Read a.ts', 'Read b.ts stopped']);
  });
});
