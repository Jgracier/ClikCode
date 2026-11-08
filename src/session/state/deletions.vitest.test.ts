import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessSession, HarnessState } from '../model.js';
import { conversationWasDeleted, deleteConversations } from './deletions.js';
import { harnessIndexPath } from './paths.js';
import { readState } from './read.js';
import { writeState } from './write.js';
import { resetHarnessStateCaches } from './index-file.js';
import { readSessionTranscript } from '../store/transcripts.js';

const stamp = new Date().toISOString();
const said = (count: number) => Array.from({ length: count }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: `m${index}` }));
const chat = (id: string, messages = said(4)): HarnessSession => ({
  id, route: 'gateway', accountId: null, provider: 'gateway', model: null, effort: 'platform-managed', permissionMode: 'bypass',
  createdAt: stamp, updatedAt: stamp, status: 'active', messages,
} as HarnessSession);

let home = '';
const files = (id: string) => ['jsonl', 'logged'].map((ext) => join(home, 'sessions', `${id}.${ext}`));
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'clikcode-deletions-'));
  process.env.CLIKCODE_HOME = home;
  resetHarnessStateCaches();
});

async function stored(ids: string[]): Promise<HarnessState> {
  const state = await readState();
  for (const id of ids) state.sessions.push(chat(id));
  await writeState(state);
  return state;
}

describe('a conversation is deleted only by deleting it', () => {
  it('a state that no longer lists a conversation does not delete it', async () => {
    const state = await stored(['a', 'b']);
    // Not deleteConversations: the list is just shorter (a filtered view, a bug, a reset).
    state.sessions = state.sessions.filter((item) => item.id !== 'a');
    await writeState(state);
    expect(files('a').every(existsSync)).toBe(true);
    expect((await readState()).sessions.map((item) => item.id).sort()).toEqual(['a', 'b']);
  });

  it('deleting removes its files and leaves a tombstone other processes can tell from a lost row', async () => {
    const state = await stored(['a', 'b']);
    deleteConversations(state, ['a']);
    await writeState(state);
    expect(files('a').some(existsSync)).toBe(false);
    expect(files('b').every(existsSync)).toBe(true);
    expect(await conversationWasDeleted('a')).toBe(true);
    expect(await conversationWasDeleted('b')).toBe(false);
    // Written again, it deletes nothing more.
    await writeState(state);
    expect((await readState()).sessions.map((item) => item.id)).toEqual(['b']);
  });

  it('an index that lost every row but one (a fresh state written over it) deletes nothing in the processes that still hold the rest', async () => {
    const holder = await stored(['a', 'b', 'c']);
    // Another process replaced the index on disk with one that lists only its own chat (what a fresh state written over it did).
    await writeFile(harnessIndexPath(), JSON.stringify({ version: 1, installationId: 'x', accounts: [], sessions: [{ ...chat('s1', said(2)), messages: undefined }], invocations: [], invocationRollups: {}, globalSettings: {}, providerSettings: {} }));
    resetHarnessStateCaches();
    // The holders write what they changed: nothing is removed, the rows come back.
    holder.sessions[0]!.title = 'touched';
    await writeState(holder);
    for (const id of ['a', 'b', 'c']) expect(files(id).every(existsSync), id).toBe(true);
    expect((await readState()).sessions.map((item) => item.id).sort()).toEqual(['a', 'b', 'c', 's1']);
    expect((await readSessionTranscript('b')).messages).toEqual(said(4));
  });

  it('a state built from scratch (no baseline) written over a stored index takes no conversation away', async () => {
    await stored(['a', 'b']);
    const scratch = { ...(await readState()), sessions: [chat('s1', said(2))] } as HarnessState;
    // Without what a read leaves on a state, as a test fixture or a new one has.
    const bare = JSON.parse(JSON.stringify(scratch)) as HarnessState;
    await writeState(bare);
    expect((await readState()).sessions.map((item) => item.id).sort()).toEqual(['a', 'b', 's1']);
  });

  it('another process that read the conversation before it was deleted learns it is gone, and does not bring it back', async () => {
    const deleter = await stored(['a', 'b']);
    const stale = await readState();
    deleteConversations(deleter, ['a']);
    await writeState(deleter);
    stale.sessions.find((item) => item.id === 'a')!.title = 'late';
    stale.sessions.find((item) => item.id === 'b')!.title = 'applied';
    await writeState(stale);
    const after = await readState();
    expect(after.sessions.map((item) => item.id)).toEqual(['b']);
    expect(after.sessions[0]!.title).toBe('applied');
    expect(files('a').some(existsSync)).toBe(false);
  });
});
