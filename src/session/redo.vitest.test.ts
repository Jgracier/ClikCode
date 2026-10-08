import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { redoFrom } from './redo.js';
import { readTurnChanges, writeTurnChanges } from './turn-changes.js';
import type { HarnessSession, HarnessState } from './model.js';

const conversation = (): HarnessSession => ({
  id: 's1', route: 'local', accountId: 'a', provider: 'anthropic', model: 'opus', effort: 'medium', nativeHarness: 'claude',
  createdAt: '', updatedAt: '', status: 'active', nativeSessionId: 'thread-1', name: 'Chat',
  messages: [
    { role: 'user', content: 'first' }, { role: 'assistant', content: 'one' },
    { role: 'user', content: 'second' }, { role: 'assistant', content: 'two' },
    { role: 'user', content: 'third' }, { role: 'assistant', content: 'three' },
  ],
} as HarnessSession);

describe('/redo', () => {
  it('goes back to before the prompt, keeps the whole conversation archived, and hands the prompt back', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'redo-'));
    const session = conversation();
    const state = { accounts: [], sessions: [session], invocations: [] } as unknown as HarnessState;
    await writeTurnChanges(stateDir, session.id, ['first', 'second', 'third'].map((prompt) => ({ at: '', prompt, changes: [] })));
    const redone = await redoFrom(state, session, 2, { keepFiles: true, stateDir, who: 'Claude Code', turnIsRunning: async () => false });
    expect(redone.prompt).toBe('second');
    expect(session.messages?.map((message) => message.content)).toEqual(['first', 'one']);
    expect(session.nativeSessionId).toBeUndefined();
    const archived = state.sessions.find((item) => item.id !== session.id)!;
    expect(archived).toMatchObject({ status: 'archived', parentSessionId: 's1', name: 'Chat (before redo)' });
    expect(archived.messages).toHaveLength(6);
    // The kept edits' records go, so /undo cannot reverse turns no longer here.
    expect((await readTurnChanges(stateDir, session.id)).map((record) => record.prompt)).toEqual(['first']);
  });

  it('refuses while a turn runs, and a prompt that is not there', async () => {
    const state = { accounts: [], sessions: [conversation()], invocations: [] } as unknown as HarnessState;
    const options = { keepFiles: true, stateDir: mkdtempSync(join(tmpdir(), 'redo-')), who: 'x' };
    await expect(redoFrom(state, state.sessions[0]!, 1, { ...options, turnIsRunning: async () => true })).rejects.toThrow(/turn is running/);
    await expect(redoFrom(state, state.sessions[0]!, 4, { ...options, turnIsRunning: async () => false })).rejects.toThrow(/prompts 1 to 3/);
    expect(state.sessions).toHaveLength(1);
  });
});
