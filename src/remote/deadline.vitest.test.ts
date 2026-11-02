import { afterEach, expect, it, vi } from 'vitest';
import { remoteDeadline } from './deadline.js';
afterEach(() => vi.useRealTimers());
it('times out without cancelling or replaying the underlying operation', async () => {
  vi.useFakeTimers();
  let complete!: (value: string) => void;
  const work = new Promise<string>((resolve) => { complete = resolve; });
  const checked = expect(remoteDeadline(work, 'unconfirmed', 50)).rejects.toThrow('unconfirmed');
  await vi.advanceTimersByTimeAsync(50); await checked;
  complete('accepted'); expect(await work).toBe('accepted');
  expect(vi.getTimerCount()).toBe(0);
});
it('cleans its timer when the acknowledgement arrives', async () => {
  vi.useFakeTimers();
  expect(await remoteDeadline(Promise.resolve('removed'), 'timeout')).toBe('removed');
  expect(vi.getTimerCount()).toBe(0);
});
