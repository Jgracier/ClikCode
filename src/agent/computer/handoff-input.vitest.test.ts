import { describe, expect, it } from 'vitest';
import { cleanPoints, cleanSize, DIFF_SOURCE, keyEvent } from './handoff-input.js';

// The phone's page runs this same source.
const diffText = new Function(`return (${DIFF_SOURCE})`)() as (prev: string, next: string) => { remove: number; add: string };

describe('what a change in the phone\'s typing box means in the page', () => {
  it('types at the end, and backspaces from the end', () => {
    expect(diffText('', 'a')).toEqual({ remove: 0, add: 'a' });
    expect(diffText('abc', 'abcd')).toEqual({ remove: 0, add: 'd' });
    expect(diffText('abc', 'ab')).toEqual({ remove: 1, add: '' });
    expect(diffText('abc', 'abc')).toEqual({ remove: 0, add: '' });
  });

  it('replaces a whole value (an autofill) or the tail of one', () => {
    expect(diffText('', 'me@example.com')).toEqual({ remove: 0, add: 'me@example.com' });
    expect(diffText('old', 'new')).toEqual({ remove: 3, add: 'new' });
    expect(diffText('hello world', 'hello there')).toEqual({ remove: 5, add: 'there' });
    // An edit in the middle is retyped from the change to the end, which is where the page's caret is.
    expect(diffText('abXcd', 'abcd')).toEqual({ remove: 3, add: 'cd' });
  });

  it('counts characters, not UTF-16 units, and does not cut an emoji in half', () => {
    expect(diffText('a😀', 'a')).toEqual({ remove: 1, add: '' });
    expect(diffText('a😀', 'a😁')).toEqual({ remove: 1, add: '😁' });
    expect(diffText('😀', '')).toEqual({ remove: 1, add: '' });
  });
});

describe('input checks', () => {
  it('accepts up to five well-formed touch points and nothing else', () => {
    expect(cleanPoints([[0, 10.5, 20], [1, 30, 40]])).toEqual([{ id: 0, x: 10.5, y: 20 }, { id: 1, x: 30, y: 40 }]);
    expect(cleanPoints([])).toEqual([]);
    for (const bad of [null, 'x', [[0, 1]], [[0, 'a', 2]], [[-1, 1, 2]], [[0, NaN, 2]], [[0, 1e9, 2]], [[0.5, 1, 2]], Array.from({ length: 6 }, (_, i) => [i, 1, 1])]) expect(cleanPoints(bad), JSON.stringify(bad)).toBeUndefined();
  });

  it('knows the editing and moving keys, and no others', () => {
    expect(keyEvent('Enter')).toMatchObject({ vk: 13, text: '\r' });
    expect(keyEvent('Backspace')).toMatchObject({ vk: 8 });
    for (const bad of ['F5', 'Control', 'a', '', 'constructor', '__proto__', 7, undefined]) expect(keyEvent(bad), String(bad)).toBeUndefined();
  });

  it('keeps the phone size to what a phone or tablet can be', () => {
    expect(cleanSize({ w: 390, h: 700, dpr: 3 })).toEqual({ w: 390, h: 700, dpr: 3 });
    expect(cleanSize({ w: 99999, h: 1, dpr: 99 })).toEqual({ w: 2400, h: 120, dpr: 3 });
    expect(cleanSize({ w: 390.4, h: 700.6, dpr: 0.2 })).toEqual({ w: 390, h: 701, dpr: 1 });
    for (const bad of [null, {}, { w: 'a', h: 1, dpr: 1 }, { w: NaN, h: 1, dpr: 1 }]) expect(cleanSize(bad)).toBeUndefined();
  });
});
