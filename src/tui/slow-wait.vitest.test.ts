import { afterEach, describe, expect, it, vi } from 'vitest';
import { withSlowWait } from './slow-wait.js';
import { SLOW_WAIT_MS } from '../harness/protocol/timings.js';

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
});
