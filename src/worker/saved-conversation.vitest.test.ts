import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { resetHarnessStateCaches } from '../session/state/index-file.js';
import type { HarnessSession } from '../session/model.js';
import { transcriptPosition } from '../session/store/transcripts.js';
import { withSavedConversation } from './saved-conversation.js';

const read = async (): Promise<HarnessSession> => {
  resetHarnessStateCaches();
  return (await readState({ transcripts: ['s'] })).sessions.find((item) => item.id === 's')!;
};

describe('a window reading the history a snapshot names', () => {
  it('reads exactly those messages, and after a rewind and a new turn -- as many messages, other ones -- draws no stale live turn over them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clikcode-saved-'));
    const previous = process.env.CLIKCODE_HOME;
    process.env.CLIKCODE_HOME = root;
    try {
      const now = new Date().toISOString();
      const state = await readState();
      state.sessions.push({
        id: 's', route: 'gateway', accountId: null, provider: 'gateway', model: null, effort: 'platform-managed', permissionMode: 'bypass',
        createdAt: now, updatedAt: now, status: 'active', messages: [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'first answer' }],
      } as HarnessSession);
      await writeState(state);
      const before = await read();
      const at = transcriptPosition(before.messages!)!;
      const live = { text: 'still going', waitingLabel: 'thinking', activities: [], plan: [] };
      const snapshot = { type: 'snapshot' as const, session: { id: 's' } as HarnessSession, saved: { count: 2, ...at }, live };
      // A turn appended since the snapshot: not drawn beside the live turn that is writing it.
      const grown = await readState({ transcripts: ['s'] });
      grown.sessions[0]!.messages = [...before.messages!, { role: 'user', content: 'two' }];
      await writeState(grown);
      expect((await withSavedConversation(snapshot)).session.messages?.map((message) => message.content)).toEqual(['one', 'first answer']);
      // Rewound to the first message, then a new turn: two messages again, not the same two.
      const rewound = await readState({ transcripts: ['s'] });
      rewound.sessions[0]!.messages = [{ role: 'user', content: 'one' }];
      await writeState(rewound);
      rewound.sessions[0]!.messages = [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'second answer' }];
      await writeState(rewound);
      const stale = await withSavedConversation(snapshot);
      expect(stale.session.messages?.map((message) => message.content)).toEqual(['one', 'second answer']);
      expect(stale).not.toHaveProperty('live');
      // The snapshot the rewrite brings names the new history, exactly.
      const after = await read();
      const current = await withSavedConversation({ ...snapshot, saved: { count: 2, ...transcriptPosition(after.messages!)! } });
      expect(current.session.messages?.map((message) => message.content)).toEqual(['one', 'second answer']);
      expect(current.live).toEqual(live);
    } finally {
      if (previous === undefined) delete process.env.CLIKCODE_HOME; else process.env.CLIKCODE_HOME = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});
