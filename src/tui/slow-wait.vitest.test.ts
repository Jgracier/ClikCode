import { afterEach, describe, expect, it, vi } from 'vitest';
import { withSlowWait } from './slow-wait.js';
import { MIN_VISIBLE_MS, SLOW_WAIT_MS } from '../harness/protocol/timings.js';

describe('a wait shown only when slow', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('shows nothing for work that finishes first', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const band = { startWaiting: (label: string) => calls.push(`start ${label}`), stopWaiting: () => calls.push('stop') };
    const done = withSlowWait(band, 'signing out', async () => 'ok');
    await vi.advanceTimersByTimeAsync(SLOW_WAIT_MS * 2);
    expect(await done).toBe('ok');
    expect(calls).toEqual([]);
  });

  it('shows the band once the work has taken SLOW_WAIT_MS, and takes it down after', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const band = { startWaiting: (label: string) => calls.push(`start ${label}`), stopWaiting: () => calls.push('stop') };
    const done = withSlowWait(band, 'checking harnesses', () => new Promise((resolve) => { setTimeout(resolve, SLOW_WAIT_MS * 3); }));
    await vi.advanceTimersByTimeAsync(SLOW_WAIT_MS + 1);
    expect(calls).toEqual(['start checking harnesses']);
    await vi.advanceTimersByTimeAsync(SLOW_WAIT_MS * 3);
    await done;
    expect(calls).toEqual(['start checking harnesses', 'stop']);
  });

  it('once shown, stays MIN_VISIBLE_MS at least, even when the work ends at once', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const band = { startWaiting: (label: string) => calls.push(`start ${label}`), stopWaiting: () => calls.push('stop') };
    const done = withSlowWait(band, 'loading', () => new Promise((resolve) => { setTimeout(resolve, SLOW_WAIT_MS + 20); }));
    await vi.advanceTimersByTimeAsync(SLOW_WAIT_MS + 20);
    expect(calls).toEqual(['start loading']);
    await vi.advanceTimersByTimeAsync(MIN_VISIBLE_MS - 40);
    expect(calls).toEqual(['start loading']);
    await vi.advanceTimersByTimeAsync(40);
    await done;
    expect(calls).toEqual(['start loading', 'stop']);
  });
});
