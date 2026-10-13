import { describe, expect, it, vi } from 'vitest';
import { withResourceNotes } from '../turn/resource-notes.js';
import { createResourceNoteDelivery } from './resource-note-delivery.js';

const ctxFor = (route: string, steerNote: () => Promise<boolean>, running = true) => ({
  sessionId: `s-${route}-${running}`, io: { currentSessionAndAccount: async () => ({ session: { route } }) },
  activeLiveInput: running ? { steerNote } : undefined,
}) as never;

describe('resource notes', () => {
  it('are never steered into, or held for, a vendor turn', async () => {
    const steerNote = vi.fn(async () => true);
    const ctx = ctxFor('local', steerNote) as { sessionId: string };
    createResourceNoteDelivery(ctx as never)('memory is tight');
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    expect(steerNote).not.toHaveBeenCalled();
    expect(withResourceNotes(ctx.sessionId, 'hi')).toBe('hi');
  });

  it('go into ClikCode\'s own running agent turn', async () => {
    const steerNote = vi.fn(async () => true);
    createResourceNoteDelivery(ctxFor('clikcode-local', steerNote))('memory is tight');
    await vi.waitFor(() => expect(steerNote).toHaveBeenCalledOnce());
  });

  it('are held for its next turn when none is running', async () => {
    const ctx = ctxFor('gateway', async () => true, false) as { sessionId: string };
    createResourceNoteDelivery(ctx as never)('memory is tight');
    await vi.waitFor(() => expect(withResourceNotes(ctx.sessionId, 'hi')).toContain('memory is tight'));
  });
});
