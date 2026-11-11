import { describe, expect, it, vi } from 'vitest';
import { sleep } from './sleep.js';

describe('sleep', () => {
  it('resolves after the time', async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      const waiting = sleep(100).then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(99);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await waiting;
      expect(done).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('rejects when its signal aborts, before or during, with the given error', async () => {
    const before = new AbortController();
    before.abort();
    await expect(sleep(10_000, before.signal, () => new Error('Stopped'))).rejects.toThrow('Stopped');
    const during = new AbortController();
    const waiting = sleep(10_000, during.signal);
    during.abort(new Error('gone'));
    await expect(waiting).rejects.toThrow('gone');
  });
});
