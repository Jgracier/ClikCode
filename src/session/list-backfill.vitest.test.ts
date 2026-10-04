import { describe, expect, it, vi } from 'vitest';

const reads = vi.hoisted(() => ({ count: 0 }));
vi.mock('./state/read.js', async (original) => {
  const actual = await original<typeof import('./state/read.js')>();
  return { ...actual, readState: async (...args: Parameters<typeof actual.readState>) => { reads.count += 1; return actual.readState(...args); } };
});

const { backfillListFacts } = await import('./list-backfill.js');
const { readState } = await import('./state/read.js');

/** The board opens on the index it has just read; deciding whether any row
 * needs summarizing must not read it again (that was half the board's open). */
describe('backfilling the list on open', () => {
  it('decides from the index the list already read, and hands only its own caller what it stored', async () => {
    const state = await readState({ transcripts: [] });
    reads.count = 0;
    expect(await backfillListFacts(state)).toBeUndefined();
    expect(reads.count).toBe(0);
    // Later lists share the one pass and are never handed an older state.
    expect(await backfillListFacts()).toBeUndefined();
    expect(reads.count).toBe(0);
  });
});
