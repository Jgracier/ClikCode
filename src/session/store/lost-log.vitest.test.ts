import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState } from '../state/read.js';
import { writeState } from '../state/write.js';
import { resetHarnessStateCaches } from '../state/index-file.js';
import type { HarnessSession } from '../model.js';
import { resetChatLogCache, writeChatLog } from './chat-log.js';
import { ConversationLogMissingError, readSessionTranscript } from './transcripts.js';

const previousHome = process.env.CLIKCODE_HOME;
let root = '';
afterEach(async () => {
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
  resetHarnessStateCaches();
  if (root) await rm(root, { recursive: true, force: true });
});

const now = new Date().toISOString();
const chat = (id: string, messages: HarnessSession['messages']): HarnessSession => ({
  id, route: 'gateway', accountId: null, provider: 'gateway', model: null, effort: 'platform-managed', permissionMode: 'bypass',
  createdAt: now, updatedAt: now, status: 'active', messages,
} as HarnessSession);
const said = (count: number, prefix = 'm') => Array.from({ length: count }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: `${prefix}${index}` }));
const sessionFiles = async () => (await readdir(join(root, 'sessions'))).sort();
const legacyFile = (id: string, messages: unknown) => writeFile(join(root, 'sessions', `${id}.json`), JSON.stringify({ v: 1, id, messages }));

describe('a conversation whose log is gone', () => {
  it('is never rebuilt from the older <id>.json it leaves behind: reading and writing it stop', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-lost-'));
    process.env.CLIKCODE_HOME = root;
    const state = await readState();
    state.sessions.push(chat('long', said(40)));
    await writeState(state);
    // An older build's copy of the same chat, from when it was short (a restored snapshot).
    await legacyFile('long', said(6));
    await unlink(join(root, 'sessions', 'long.jsonl'));
    resetHarnessStateCaches();

    await expect(readSessionTranscript('long')).rejects.toBeInstanceOf(ConversationLogMissingError);
    await expect(readState({ transcripts: ['long'] })).rejects.toThrow(/clikcode sessions repair long/);

    // A writer that still holds the conversation does not make the old copy its history either.
    state.sessions[0]!.messages = [...state.sessions[0]!.messages!, { role: 'user', content: 'one more' }];
    await expect(writeState(state)).rejects.toBeInstanceOf(ConversationLogMissingError);
    expect(await sessionFiles()).not.toContain('long.jsonl');
  });

  it('does not keep the whole listing from loading: every chat is listed, this one unopened', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-lost-'));
    process.env.CLIKCODE_HOME = root;
    const state = await readState();
    state.sessions.push(chat('gone', said(8)), chat('fine', said(4)));
    await writeState(state);
    await unlink(join(root, 'sessions', 'gone.jsonl'));
    resetHarnessStateCaches();
    const all = await readState();
    expect(all.sessions.map((item) => item.id).sort()).toEqual(['fine', 'gone']);
    expect(all.sessions.find((item) => item.id === 'fine')!.messages).toEqual(said(4));
    expect(all.sessions.find((item) => item.id === 'gone')!.messages).toBeUndefined();
    // Writing the listing back leaves the lost one alone.
    await writeState(all);
    expect(await sessionFiles()).not.toContain('gone.jsonl');
  });
});

describe('a conversation that never had a log', () => {
  it('is still read from its <id>.json, and moves to a log the first time it is written', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-lost-'));
    process.env.CLIKCODE_HOME = root;
    const state = await readState();
    state.sessions.push(chat('old', said(2)));
    await writeState(state);
    // As an older build left it: the chat in <id>.json alone, no log, no mark.
    await unlink(join(root, 'sessions', 'old.jsonl'));
    await unlink(join(root, 'sessions', 'old.logged'));
    await legacyFile('old', said(6));
    resetHarnessStateCaches();
    resetChatLogCache();
    expect((await readSessionTranscript('old')).messages).toEqual(said(6));
    expect(await sessionFiles()).not.toContain('old.logged');
    const again = await readState({ transcripts: ['old'] });
    again.sessions[0]!.messages = [...again.sessions[0]!.messages!, { role: 'user', content: 'next' }];
    await writeState(again);
    expect(await sessionFiles()).toEqual(expect.arrayContaining(['old.jsonl', 'old.logged']));
  });

  it('marks a log an earlier build made the first time it is seen', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-lost-'));
    process.env.CLIKCODE_HOME = root;
    const state = await readState();
    state.sessions.push(chat('other', said(2)));
    await writeState(state);
    // A log written before marks existed.
    await writeChatLog('made', { messages: said(4) });
    expect(await sessionFiles()).not.toContain('made.logged');
    await readSessionTranscript('made');
    expect((await stat(join(root, 'sessions', 'made.logged'))).size).toBe(0);
  });
});

describe('a search over every conversation', () => {
  it('skips one whose log is gone instead of failing', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-lost-'));
    process.env.CLIKCODE_HOME = root;
    const state = await readState();
    state.sessions.push(chat('gone', said(8)), chat('fine', said(4)));
    await writeState(state);
    await unlink(join(root, 'sessions', 'gone.jsonl'));
    resetHarnessStateCaches();
    const { sessionDoc, resetCorpusCache } = await import('../../search/corpus.js');
    resetCorpusCache();
    expect(await sessionDoc('gone')).toBeUndefined();
    expect((await sessionDoc('fine'))?.messages).toHaveLength(4);
  });
});
