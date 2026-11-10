import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { resetHarnessStateCaches } from '../session/state/index-file.js';
import type { HarnessSession } from '../session/model.js';
import { DurableTurnCheckpoint, preserveInterruptedTurn } from './turn-journal.js';

/** A hard Stop ends the turn at the worker while the turn itself runs on (it
 * waits on something that never answers). Its `finally` still flushes the
 * checkpoint: written after the stop was settled, that write put the closed
 * turn back as running. */
describe('a turn ended by a hard Stop', () => {
  it('writes nothing after its checkpoint is closed, so the stopped turn stays stopped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clikcode-hard-stop-'));
    const previous = process.env.CLIKCODE_HOME;
    process.env.CLIKCODE_HOME = root;
    try {
      const state = await readState();
      const now = new Date(Date.now() - 60_000).toISOString();
      const session = {
        id: 's', route: 'gateway', accountId: null, provider: 'gateway', model: null, effort: 'platform-managed', permissionMode: 'bypass',
        createdAt: now, updatedAt: now, status: 'active', messages: [{ role: 'user', content: 'earlier' }],
      } as HarnessSession;
      state.sessions.push(session);
      await writeState(state);
      const checkpoint = await DurableTurnCheckpoint.start(state, session, 'go', undefined);
      await checkpoint.flush();
      checkpoint.response('partial ');
      await checkpoint.flush();

      // The Stop: the worker closes the turn's checkpoint, then settles the turn from disk.
      await checkpoint.close();
      await preserveInterruptedTurn('s', 'go', 'partial ', true);
      // The losing turn goes on, and its finally flushes.
      checkpoint.response('more');
      checkpoint.touch();
      await checkpoint.flush();
      await checkpoint.complete('partial more');

      resetHarnessStateCaches();
      const stored = (await readState({ transcripts: ['s'] })).sessions.find((item) => item.id === 's')!;
      expect(stored.pendingTurn).toBeUndefined();
      expect(stored.messages?.at(-1)?.content?.trim()).toBe('partial');
      // A message queued into a closed turn is refused, so it goes back to the composer.
      await expect(checkpoint.queue({ id: 'q', text: 'late', submittedAt: new Date().toISOString() })).rejects.toThrow();
    } finally {
      if (previous === undefined) delete process.env.CLIKCODE_HOME;
      else process.env.CLIKCODE_HOME = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});
