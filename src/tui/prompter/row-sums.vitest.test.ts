import { describe, expect, it } from 'vitest';
import { RowSums } from './row-sums.js';
import { HistoryWindow } from './history-window.js';
import { estimatedRows } from '../render/reseed-window.js';

describe('RowSums', () => {
  const naive = (values: number[], index: number) => values.slice(0, index).reduce((a, b) => a + b, 0);

  it('sums, replaces and finds rows like a plain loop', () => {
    const values = Array.from({ length: 37 }, (_, i) => (i * 7) % 5);
    const sums = new RowSums();
    for (const value of values) sums.push(value);
    for (let i = 0; i <= values.length; i += 1) expect(sums.before(i)).toBe(naive(values, i));
    values[3] = 11; sums.set(3, 11);
    values[30] = 0; sums.set(30, 0);
    for (let i = 0; i <= values.length; i += 1) expect(sums.before(i)).toBe(naive(values, i));
    const total = naive(values, values.length);
    for (let row = 0; row < total; row += 1) {
      const found = sums.at(row)!;
      expect(naive(values, found.index) + found.into).toBe(row);
      expect(found.into).toBeLessThan(values[found.index]!);
    }
    expect(sums.at(total + 5)).toEqual({ index: values.length - 1, into: 5 + values[values.length - 1]! });
    sums.truncate(10);
    expect(sums.before(40)).toBe(naive(values, 10));
    sums.push(4);
    expect(sums.before(11)).toBe(naive(values, 10) + 4);
  });
});

describe('HistoryWindow row counts', () => {
  const messages = Array.from({ length: 50 }, (_, n) => ({ role: 'assistant' as const, content: `answer ${n}\n\nmore` }));
  const each = estimatedRows(messages[0]!.content, 80);

  it('replaces an estimate with a measured count, keeps it across a rewrite at the same width, drops it at another', () => {
    const h = new HistoryWindow();
    h.source = { messages, inner: 80, conversation: 'a' };
    expect(h.rowsBetween(0, 50)).toBe(50 * each);
    h.measure(10, each + 7);
    expect(h.rowsBetween(0, 50)).toBe(50 * each + 7);
    expect(h.messageAt(11 * each + 7)).toEqual({ message: 11, into: 0 });
    h.reset();
    expect(h.measured(10)).toBe(each + 7);
    expect(h.rowsBetween(0, 50)).toBe(50 * each + 7);
    h.source = { messages, inner: 60, conversation: 'a' };
    expect(h.measured(10)).toBeUndefined();
    h.source = { messages, inner: 60, conversation: 'b' };
    h.measure(1, 1);
    h.source = { messages, inner: 60, conversation: 'a' };
    expect(h.measured(1)).toBeUndefined();
  });

  it('counts messages that arrive later, and forgets those past a shorter list', () => {
    const list = messages.slice(0, 10);
    const h = new HistoryWindow();
    h.source = { messages: list, inner: 80 };
    expect(h.rowsBetween(0, 10)).toBe(10 * each);
    h.measure(9, 1);
    h.source = { messages: messages.slice(0, 20), inner: 80 };
    expect(h.rowsBetween(0, 20)).toBe(19 * each + 1);
    h.source = { messages: messages.slice(0, 5), inner: 80 };
    expect(h.rowsBetween(0, 20)).toBe(5 * each);
    expect(h.measured(9)).toBeUndefined();
  });
});
