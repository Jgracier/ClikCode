import { describe, expect, it } from 'vitest';
import type { HarnessActivityEvent } from '../../harness/prompter.js';
import { CallGrouping, GroupRegistry } from './call-groups.js';
import { extractTags, parseTag, tagRow } from './row-tags.js';

const call = (key: string, kind: HarnessActivityEvent['kind'] = 'tool-done', offset = 10, extra: Partial<HarnessActivityEvent> = {}) => ({
  key, responseOffset: offset, event: { kind, label: `$ ${key}`, category: 'run' as const, id: key, ...extra },
});
const shape = (runs: ReturnType<CallGrouping['group']>) => runs.map((run) => [run.items.map((item) => item.key).join('+'), run.done]);

describe('a turn\'s calls and thoughts, grouped while they happen', () => {
  it('holds a finished call while it is the tail, so the next can join it', () => {
    const grouping = new CallGrouping();
    expect(shape(grouping.group([call('a')], false, 10))).toEqual([['a', false]]);
    expect(shape(grouping.group([call('a'), call('b', 'tool-start')], false, 10))).toEqual([['a+b', false]]);
    expect(shape(grouping.group([call('a'), call('b')], false, 10))).toEqual([['a+b', false]]);
  });

  it('settles a run once prose follows it, and seals it', () => {
    const grouping = new CallGrouping();
    expect(shape(grouping.group([call('a'), call('b')], false, 40))).toEqual([['a+b', true]]);
    // A sealed run takes no more, even at the same offset.
    expect(shape(grouping.group([call('a'), call('b'), call('c')], false, 40))).toEqual([['a+b', true], ['c', true]]);
    const after = new CallGrouping();
    after.group([call('a'), call('b')], false, 40);
    expect(shape(after.group([call('a'), call('b'), call('c', 'tool-done', 40)], false, 40))).toEqual([['a+b', true], ['c', false]]);
  });

  it('does not settle while one of its calls still runs', () => {
    const grouping = new CallGrouping();
    expect(shape(grouping.group([call('a'), call('b', 'tool-start')], false, 40))).toEqual([['a+b', false]]);
  });

  it('never joins across prose, and settles everything when the turn ends', () => {
    const grouping = new CallGrouping();
    expect(shape(grouping.group([call('a', 'tool-done', 0), call('b', 'tool-start', 12)], false, 12))).toEqual([['a', true], ['b', false]]);
    expect(shape(grouping.group([call('a', 'tool-done', 0), call('b', 'tool-start', 12)], true, 12))).toEqual([['a', true], ['b', true]]);
  });

  it('puts a thought in the run of the calls around it', () => {
    const grouping = new CallGrouping();
    const thought = { key: 't', responseOffset: 10, thought: { durationMs: 2000 }, event: { kind: 'thinking' as const, label: 'hm' } };
    expect(shape(grouping.group([call('a'), thought, call('b')], true, 10))).toEqual([['a+t+b', true]]);
  });

  it('is the same run whether it is seen as it happens or all at once', () => {
    const rows = [call('a'), call('b', 'tool-error'), call('c'), call('d', 'tool-done', 30)];
    const live = new CallGrouping();
    live.group(rows.slice(0, 1), false, 10);
    live.group(rows.slice(0, 3), false, 10);
    const final = live.group(rows, true, 30);
    expect(shape(final)).toEqual(shape(new CallGrouping().group(rows, true, 30)));
  });
});

describe('the groups kept for expansion', () => {
  it('keeps the newest fifty', () => {
    const registry = new GroupRegistry();
    for (let index = 0; index < 60; index += 1) registry.set({ id: `g${index}`, items: [], running: false });
    expect(registry.size).toBe(50);
    expect(registry.get('g9')).toBeUndefined();
    expect(registry.latest()?.id).toBe('g59');
  });
});

describe('row tags', () => {
  it('ride in front of a row and come off clean', () => {
    const rows = ['plain', tagRow('  ‣ Ran 2 commands', { kind: 'g', group: '3:a b|c', item: 'x/y' }), ''];
    const { rows: clean, tags } = extractTags(rows);
    expect(clean).toEqual(['plain', '  ‣ Ran 2 commands', '']);
    expect(tags[0]).toBeUndefined();
    expect(parseTag(tags[1])).toEqual({ kind: 'g', group: '3:a b|c', item: 'x/y' });
  });
});
