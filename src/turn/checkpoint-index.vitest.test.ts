import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { resetHarnessStateCaches } from '../session/state/index-file.js';
import type { HarnessSession } from '../session/model.js';
import { DurableTurnCheckpoint } from './turn-journal.js';

/** A streaming answer is the transcript's business. The index -- every
 * process's shared list -- used to be rewritten (and backed up) on each 250ms
 * checkpoint because a delta moved the session's date; with a long history of
 * accounts and invocations on it, that was most of ClikCode's disk writes. */
describe('a streaming turn and the shared index', () => {
  it('stores the growing answer without rewriting the index, then stores the row once at the end', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clikcode-stream-'));
    const previous = process.env.CLIKCODE_HOME;
    process.env.CLIKCODE_HOME = root;
    try {
      const state = await readState();
      const now = new Date(Date.now() - 60_000).toISOString();
      const session = {
        id: 's', route: 'gateway', accountId: null, provider: 'gateway', model: null, effort: 'platform-managed', permissionMode: 'bypass',
        accountFailover: 'never', createdAt: now, updatedAt: now, status: 'active', messages: [{ role: 'user', content: 'earlier' }],
      } as HarnessSession;
      state.sessions.push(session);
      await writeState(state);

      const checkpoint = await DurableTurnCheckpoint.start(state, session, 'go', undefined);
      const indexPath = join(root, 'index.json');
      const started = await stat(indexPath);
      for (let step = 0; step < 4; step++) {
        checkpoint.response(`part ${step} `);
        checkpoint.activity({ kind: 'tool-start', label: 'read', id: `c${step}` } as never);
        session.lastUsage = { input: step, output: step, at: new Date().toISOString() } as never;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      // The index is the very file the turn's start wrote...
      const during = await stat(indexPath);
      expect({ ino: during.ino, mtimeMs: during.mtimeMs }).toEqual({ ino: started.ino, mtimeMs: started.mtimeMs });
      // ...and the answer so far is on disk.
      const stored = JSON.parse(await readFile(join(root, 'sessions', 's.json'), 'utf8'));
      expect(stored.pendingTurn?.response).toBe('part 0 part 1 part 2 part 3 ');

      await checkpoint.complete('part 0 part 1 part 2 part 3 done');
      resetHarnessStateCaches();
      const finished = (await readState()).sessions.find((item) => item.id === 's')!;
      expect(finished.pendingTurn).toBeUndefined();
      expect(finished.messages?.at(-1)?.content).toBe('part 0 part 1 part 2 part 3 done');
      // What the turn changed on the row mid-stream is stored at its end.
      expect(finished.lastUsage).toMatchObject({ input: 3, output: 3 });
      expect(finished.updatedAt > now).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.CLIKCODE_HOME;
      else process.env.CLIKCODE_HOME = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});
