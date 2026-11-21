// A reference from before a frame reload makes Playwright THROW from count(); locate must say what happened and what to do, not leak the selector error.
import { describe, expect, it } from 'vitest';
import { locate } from '../tools/computer-web.js';

// A page whose reference is gone for good: neither a fresh read brings it back, nor was it ever shown under a name.
const reads = { count: 0 };
const gone = (count: () => Promise<number>) => ({ locator: () => ({ count }), ariaSnapshot: async () => { reads.count++; return ''; }, frames: () => [], mainFrame: () => undefined }) as never;
const pageWhoseRefThrows = gone(async () => { throw new Error('locator.count: Invalid frame in aria-ref selector "aria-ref=f1e90"'); });
const pageWithNoSuchRef = gone(async () => 0);

describe('locate with a reference that no longer exists', () => {
  it('turns a stale-frame selector error into the element-is-gone message, with the way out, after reading the page once more', async () => {
    await expect(locate(pageWhoseRefThrows, 'f1e90')).rejects.toThrow(/Nothing on the page has the reference f1e90 now: the page removed or replaced that element after it was read.*visible text/s);
    expect(reads.count).toBe(1);
    await expect(locate(pageWithNoSuchRef, 'e5')).rejects.toThrow(/Nothing on the page has the reference e5 now/);
    expect(reads.count).toBe(2);
  });
});
