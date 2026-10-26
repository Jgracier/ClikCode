import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { eventDiff } from '../agent/line-diff.js';
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
    // Nothing to report: no recap of what the screen and the message box already show.
    expect(redone.text).toBe('');
    expect(session.messages?.map((message) => message.content)).toEqual(['first', 'one']);
    expect(session.nativeSessionId).toBeUndefined();
    const archived = state.sessions.find((item) => item.id !== session.id)!;
    expect(archived).toMatchObject({ status: 'archived', parentSessionId: 's1', name: 'Chat (before redo)' });
    expect(archived.messages).toHaveLength(6);
    // The kept edits' records go, so /undo cannot reverse turns no longer here.
    expect((await readTurnChanges(stateDir, session.id)).map((record) => record.prompt)).toEqual(['first']);
  });

  it('says so when an edit could not be put back, and only then', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'redo-files-'));
    const stateDir = join(dir, 'state');
    const workspace = join(dir, 'ws');
    mkdirSync(workspace, { recursive: true });
    const file = join(workspace, 'a.txt');
    writeFileSync(file, 'something else entirely\n');
    const session = { ...conversation(), route: 'local', workspace } as HarnessSession;
    const state = { accounts: [], sessions: [session], invocations: [] } as unknown as HarnessState;
    // The turn changed `a.txt` from `two` to `TWO`; it holds something else now, so putting it back would lose that.
    await writeTurnChanges(stateDir, session.id, ['first', 'second', 'third'].map((prompt, index) => ({
      at: new Date().toISOString(), prompt, changes: index === 2 ? eventDiff('two', 'TWO', { path: 'a.txt' })! : [],
    })));
    const redone = await redoFrom(state, session, 3, { keepFiles: false, stateDir, who: 'Claude Code', turnIsRunning: async () => false });
    expect(redone.prompt).toBe('third');
    expect(redone.text).toMatch(/a\.txt/);
    expect(readFileSync(file, 'utf8')).toBe('something else entirely\n');
  });

  it('refuses while a turn runs, and a prompt that is not there', async () => {
    const state = { accounts: [], sessions: [conversation()], invocations: [] } as unknown as HarnessState;
    const options = { keepFiles: true, stateDir: mkdtempSync(join(tmpdir(), 'redo-')), who: 'x' };
    await expect(redoFrom(state, state.sessions[0]!, 1, { ...options, turnIsRunning: async () => true })).rejects.toThrow(/turn is running/);
    await expect(redoFrom(state, state.sessions[0]!, 4, { ...options, turnIsRunning: async () => false })).rejects.toThrow(/prompts 1 to 3/);
    expect(state.sessions).toHaveLength(1);
  });
});
