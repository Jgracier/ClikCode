// A reference from before a frame reload makes Playwright THROW from count(); locate must say what happened and what to do, not leak the selector error.
import { describe, expect, it } from 'vitest';
import { locate } from '../tools/computer-web.js';

const pageWhoseRefThrows = { locator: () => ({ count: async () => { throw new Error('locator.count: Invalid frame in aria-ref selector "aria-ref=f1e90"'); } }) } as never;
const pageWithNoSuchRef = { locator: () => ({ count: async () => 0 }) } as never;

describe('locate with a reference that no longer exists', () => {
  it('turns a stale-frame selector error into the page-changed message, with the way out', async () => {
    await expect(locate(pageWhoseRefThrows, 'f1e90')).rejects.toThrow(/Nothing on the page has the reference f1e90: the page has changed since it was read.*visible text/s);
    await expect(locate(pageWithNoSuchRef, 'e5')).rejects.toThrow(/Nothing on the page has the reference e5/);
  });
});
