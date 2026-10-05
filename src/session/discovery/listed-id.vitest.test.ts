/** Goose resumes by its own id (`20261005_1`) what ClikCode created under a
 * minted name: the id is looked up by that name in `goose session list`
 * (the row shape is goose 1.51.0's, captured in vendor-sandbox). */
import { describe, expect, it, vi } from 'vitest';
import { AI_LOCAL_HARNESSES } from '@clikcode/router/ai-local-harness';
import type { AiLocalHarnessDefinition } from '../../harness/definition.js';

const listing = vi.hoisted(() => ({ output: '', calls: 0 }));
vi.mock('../../harness/transport/native/command.js', async (original) => ({
  ...await original<object>(),
  captureNativeHarnessOutput: async () => { listing.calls += 1; return listing.output; },
}));
const { adoptListedNativeId } = await import('./cli-listing.js');

const goose = AI_LOCAL_HARNESSES.find((item) => item.command === 'goose') as AiLocalHarnessDefinition;
const minted = 'af490bd2-f1a7-419a-b92f-feb2df6157f5';
listing.output = JSON.stringify([
  { id: '20261005_2', working_dir: '/w', name: 'Something the user named', user_set_name: false, created_at: '2026-10-05T18:31:00Z' },
  { id: '20261005_1', working_dir: '/w', name: minted, user_set_name: true, created_at: '2026-10-05T18:30:48Z' },
]);

describe("Goose's own session id", () => {
  it('replaces the minted name, from the turn just run or an older chat', async () => {
    const session = { nativeSessionId: minted };
    expect(await adoptListedNativeId(goose, session, {})).toBe(true);
    expect(session.nativeSessionId).toBe('20261005_1');
  });

  it('leaves an id that is already Goose\'s, an unconfirmed one, and other harnesses alone, without listing', async () => {
    listing.calls = 0;
    expect(await adoptListedNativeId(goose, { nativeSessionId: '20261005_1' }, {})).toBe(false);
    expect(await adoptListedNativeId(goose, { nativeSessionId: minted, nativeSessionPreallocated: true }, {})).toBe(false);
    const claude = AI_LOCAL_HARNESSES.find((item) => item.command === 'claude') as AiLocalHarnessDefinition;
    expect(await adoptListedNativeId(claude, { nativeSessionId: minted }, {})).toBe(false);
    expect(listing.calls).toBe(0);
  });

  it('keeps the name when the listing does not have it', async () => {
    const session = { nativeSessionId: '00000000-0000-4000-8000-000000000000' };
    expect(await adoptListedNativeId(goose, session, {})).toBe(false);
    expect(session.nativeSessionId).toBe('00000000-0000-4000-8000-000000000000');
  });
});
