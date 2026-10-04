import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPIN_MS } from '../../../../src/harness/protocol/timings';
import { onTick, setViewVisible } from '../../src/webview/clock';

describe('the page clock', () => {
  beforeEach(() => { vi.useFakeTimers(); setViewVisible(true); });
  afterEach(() => vi.useRealTimers());

  it('steps every spinner from one interval', () => {
    const created = vi.spyOn(globalThis, 'setInterval');
    let a = 0;
    let b = 0;
    const offA = onTick('spin', () => { a += 1; });
    const offB = onTick('spin', () => { b += 1; });
    vi.advanceTimersByTime(SPIN_MS * 3);
    expect([a, b]).toEqual([3, 3]);
    expect(created).toHaveBeenCalledTimes(1);
    offA();
    offB();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stands still while the view is hidden, and catches up the second when shown', () => {
    let ticks = 0;
    const off = onTick('second', () => { ticks += 1; });
    setViewVisible(false);
    vi.advanceTimersByTime(5000);
    expect(ticks).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    setViewVisible(true);
    expect(ticks).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(ticks).toBe(2);
    off();
  });
});
