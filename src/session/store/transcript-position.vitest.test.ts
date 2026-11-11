import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState } from '../state/read.js';
import { writeState } from '../state/write.js';
import { resetHarnessStateCaches } from '../state/index-file.js';
import type { HarnessSession } from '../model.js';
import { readTranscriptAt, transcriptPosition } from './transcripts.js';

describe('where a history stands in its log', () => {
  it('names exactly the messages a snapshot held, and nothing after a rewind and a new turn with the same count', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clikcode-position-'));
    const previous = process.env.CLIKCODE_HOME;
    process.env.CLIKCODE_HOME = root;
    try {
      const now = new Date().toISOString();
      let state = await readState();
      state.sessions.push({
        id: 's', route: 'gateway', accountId: null, provider: 'gateway', model: null, effort: 'platform-managed', permissionMode: 'bypass',
        createdAt: now, updatedAt: now, status: 'active', messages: [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'first answer' }],
      } as HarnessSession);
      await writeState(state);
      resetHarnessStateCaches();
      state = await readState({ transcripts: ['s'] });
      const held = state.sessions.find((item) => item.id === 's')!.messages!;
      const at = transcriptPosition(held);
      expect(at).toMatchObject({ end: 2 });
      expect((await readTranscriptAt('s', at!))?.map((message) => message.content)).toEqual(['one', 'first answer']);
      // Rewound to the first message, and a new turn: as many messages as before, not the same ones.
      const session = state.sessions.find((item) => item.id === 's')!;
      session.messages = [{ role: 'user', content: 'one' }];
      await writeState(state);
      session.messages = [...session.messages, { role: 'assistant', content: 'second answer' }];
      await writeState(state);
      expect(await readTranscriptAt('s', at!)).toBeUndefined();
      const now2 = (await readState({ transcripts: ['s'] })).sessions.find((item) => item.id === 's')!.messages!;
      expect(now2).toHaveLength(held.length);
      expect((await readTranscriptAt('s', transcriptPosition(now2)!))?.map((message) => message.content)).toEqual(['one', 'second answer']);
    } finally {
      if (previous === undefined) delete process.env.CLIKCODE_HOME; else process.env.CLIKCODE_HOME = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});
