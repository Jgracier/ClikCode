import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState } from './read.js';
import { writeState, writeTranscriptCheckpoint } from './write.js';
import { STATE_BASELINE, type BaselinedState } from './merge.js';
import { resetSessionStoreCache } from '../store/records.js';
import type { HarnessSession } from '../model.js';
import { listStoredSessionIds } from '../store/records.js';
import { stat } from 'node:fs/promises';
import { DurableTurnCheckpoint } from '../../turn/turn-journal.js';

const previousHome = process.env.CLIKCODE_HOME;
let root: string | undefined;

afterEach(async () => {
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe('writing state a caller keeps changing', () => {
  it('stores a change made while an earlier write of the same object was in flight', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-write-'));
    process.env.CLIKCODE_HOME = root;
    const state = await readState();
    const now = new Date().toISOString();
    const session = {
      id: 's', route: 'gateway', accountId: null, provider: 'gateway', model: null, effort: 'platform-managed', permissionMode: 'bypass',
createdAt: now, updatedAt: now, status: 'active', messages: [{ role: 'user', content: 'hello' }],
    } as HarnessSession;
    state.sessions.push(session);
    await writeState(state);

    // A turn checkpoint: the session keeps changing -- a message queued, the
    // answer growing -- at every step of a write that is still going on.
    let done = false;
    const first = writeState(state).finally(() => { done = true; });
    let step = 0;
    while (!done) {
      step++;
      session.queuedTurns = [...(session.queuedTurns ?? []), { id: `q${step}`, text: `queued ${step}`, submittedAt: now }];
      session.messages = [...session.messages!, { role: 'assistant', content: `part ${step}` }];
      await new Promise((resolve) => setImmediate(resolve));
    }
    await first;
    // The write made for those changes stores all of them.
    await writeState(state);
    const stored = (await readState()).sessions.find((item) => item.id === 's')!;
    expect(stored.queuedTurns?.map((item) => item.id)).toEqual(session.queuedTurns!.map((item) => item.id));
    expect(stored.messages).toEqual(session.messages);
  });
});

describe('a streaming turn\'s checkpoint', () => {
  const setup = async (history: number) => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-write-'));
    process.env.CLIKCODE_HOME = root;
    const state = await readState();
    const now = new Date().toISOString();
    const session = {
      id: 's', route: 'gateway', accountId: null, provider: 'gateway', model: null, effort: 'platform-managed', permissionMode: 'bypass',
createdAt: now, updatedAt: now, status: 'active',
      messages: Array.from({ length: history }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: `message ${index}` })),
      pendingTurn: { prompt: 'go', response: '', startedAt: now, updatedAt: now },
    } as HarnessSession;
    state.sessions.push(session);
    await writeState(state);
    await writeState(state);
    return { state, session };
  };
  const baselineHistory = (state: object) => (state as BaselinedState)[STATE_BASELINE]!.sessions.get('s')!.transcript.messages;

  it('neither copies nor compares the history again while only the answer grows', async () => {
    const { state, session } = await setup(5_000);
    const history = baselineHistory(state);
    for (let step = 1; step <= 3; step++) {
      session.pendingTurn!.response += ` part ${step}`;
      await writeState(state);
      // The same copy of the history, not a fresh one: nothing re-copied it.
      expect(baselineHistory(state)).toBe(history);
    }
    resetSessionStoreCache();
    const stored = (await readState()).sessions.find((item) => item.id === 's')!;
    expect(stored.pendingTurn?.response).toBe(' part 1 part 2 part 3');
    expect(stored.messages).toEqual(session.messages);
  });

  it('still sees history that grew or whose last message changed in place', async () => {
    const { state, session } = await setup(3);
    session.messages!.push({ role: 'assistant', content: 'appended in place' });
    await writeState(state);
    session.messages![session.messages!.length - 1]!.content = 'edited in place';
    await writeState(state);
    resetSessionStoreCache();
    const stored = (await readState()).sessions.find((item) => item.id === 's')!;
    expect(stored.messages?.at(-1)).toEqual({ role: 'assistant', content: 'edited in place' });
    expect(stored.messages).toHaveLength(4);
  });
});

describe('a list that does not open every transcript', () => {
  it('renames one chat and leaves the other transcript on disk', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-light-'));
    process.env.CLIKCODE_HOME = root;
    const state = await readState();
    const now = new Date().toISOString();
    const make = (id: string, content: string): HarnessSession => ({
      id, route: 'gateway', accountId: null, provider: 'gateway', model: null, effort: 'platform-managed', permissionMode: 'bypass',
createdAt: now, updatedAt: now, status: 'active', messages: [{ role: 'user', content }],
    } as HarnessSession);
    state.sessions.push(make('a', 'hello from a'), make('b', 'hello from b'));
    await writeState(state);
    const loaded = await readState();
    await writeState(loaded);
    resetSessionStoreCache();
    const light = await readState({ transcripts: [] });
    expect(light.sessions.find((session) => session.id === 'a')?.messages).toBeUndefined();
    expect(light.sessions.find((session) => session.id === 'a')?.listPreview).toBe('hello from a');
    expect(light.sessions.find((session) => session.id === 'a')?.listMessageCount).toBe(1);
    expect(light.sessions.find((session) => session.id === 'a')?.listChecked).toBe(true);
    const renamed = light.sessions.find((session) => session.id === 'b')!;
    renamed.name = 'Renamed';
    await writeState(light);
    resetSessionStoreCache();
    const full = await readState();
    expect(full.sessions.find((session) => session.id === 'a')?.messages?.[0]?.content).toBe('hello from a');
    expect(full.sessions.find((session) => session.id === 'b')).toMatchObject({ name: 'Renamed', messages: [{ role: 'user', content: 'hello from b' }] });
  });

  it('runs a turn on a read of its own transcript only, leaving every other chat as stored', async () => {
    // What a worker does: it reads only its conversation's history.
    root = await mkdtemp(join(tmpdir(), 'clikcode-own-'));
    process.env.CLIKCODE_HOME = root;
    const state = await readState();
    const now = new Date().toISOString();
    const make = (id: string, content: string): HarnessSession => ({
      id, route: 'gateway', accountId: null, provider: 'gateway', model: null, effort: 'platform-managed', permissionMode: 'bypass',
createdAt: now, updatedAt: now, status: 'active', messages: [{ role: 'user', content }],
    } as HarnessSession);
    state.sessions.push(make('mine', 'first'), make('other', 'hello from other'));
    await writeState(state);
    await writeState(await readState());
    resetSessionStoreCache();
    const own = await readState({ transcripts: ['mine'] });
    expect(own.sessions.find((session) => session.id === 'other')?.messages).toBeUndefined();
    const mine = own.sessions.find((session) => session.id === 'mine')!;
    mine.pendingTurn = { prompt: 'go', response: '', startedAt: now, updatedAt: now };
    await writeState(own);
    mine.pendingTurn.response = 'streamed';
    mine.pendingTurn.updatedAt = new Date(Date.parse(now) + 1000).toISOString();
    expect(await writeTranscriptCheckpoint(own, 'mine')).toBe(true);
    mine.messages = [...mine.messages!, { role: 'user', content: 'go' }, { role: 'assistant', content: 'streamed' }];
    delete mine.pendingTurn;
    mine.updatedAt = new Date(Date.parse(now) + 2000).toISOString();
    await writeState(own);
    resetSessionStoreCache();
    const full = await readState();
    expect(full.sessions.find((session) => session.id === 'other')).toMatchObject({ messages: [{ role: 'user', content: 'hello from other' }], listPreview: 'hello from other' });
    expect(full.sessions.find((session) => session.id === 'mine')?.messages?.map((message) => message.content)).toEqual(['first', 'go', 'streamed']);
  });

  it('keeps a turn in flight in the transcript only: the index row carries no copy of it', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-list-turn-'));
    process.env.CLIKCODE_HOME = root;
    const state = await readState();
    const now = new Date().toISOString();
    const session = {
      id: 's', route: 'gateway', accountId: null, provider: 'gateway', model: null, effort: 'platform-managed', permissionMode: 'bypass',
createdAt: now, updatedAt: now, status: 'active',
      messages: [{ role: 'user', content: 'hello' }],
      pendingTurn: { prompt: 'go', response: 'partial', startedAt: now, updatedAt: now, outputStarted: true },
    } as HarnessSession;
    state.sessions.push(session);
    await writeState(state);
    const loaded = await readState();
    await writeState(loaded);
    resetSessionStoreCache();
    const light = await readState({ transcripts: [] });
    expect((light.sessions[0] as { listTurn?: unknown }).listTurn).toBeUndefined();
    expect(light.sessions[0]?.pendingTurn).toBeUndefined();
    expect(light.sessions[0]?.listPreview).toBe('hello');
    const again = await readState();
    again.sessions[0]!.pendingTurn!.response += ' more';
    again.sessions[0]!.pendingTurn!.updatedAt = new Date(Date.parse(now) + 1000).toISOString();
    await writeState(again);
    resetSessionStoreCache();
    const after = await readState({ transcripts: [] });
    expect(JSON.stringify(after.sessions[0])).not.toContain('partial');
    expect((await readState()).sessions[0]?.pendingTurn?.response).toBe('partial more');
  });
});

describe('a chat nothing has happened in', () => {
  it('is kept for this process and never written', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-draft-'));
    process.env.CLIKCODE_HOME = root;
    const state = await readState();
    const now = new Date().toISOString();
    const draft = {
      id: 'draft', route: 'local', accountId: null, provider: null, model: null, effort: 'medium',
      permissionMode: 'ask', createdAt: now, updatedAt: now, status: 'active',
    } as HarnessSession;
    state.sessions.push(draft);
    await writeState(state);
    expect(await listStoredSessionIds()).not.toContain('draft');
    resetSessionStoreCache();
    const again = await readState();
    expect(again.sessions.map((session) => session.id)).toContain('draft');
    draft.messages = [{ role: 'user', content: 'now it happened' }];
    await writeState(state);
    resetSessionStoreCache();
    const stored = await readState();
    expect(stored.sessions.find((session) => session.id === 'draft')?.messages?.[0]?.content).toBe('now it happened');
    expect(await listStoredSessionIds()).toContain('draft');
  });
});

describe('a draft another process stored meanwhile', () => {
  it('is merged into, not overwritten by, the copy read while it was a draft', async () => {
    // The chat opened as a draft (Claude Code, its default) and a slow read
    // took it (the editor's usage refresh). Meanwhile the user chose OpenCode
    // and its first turn stored the conversation. The slow read then wrote
    // back: with no baseline for the draft, every field of it replaced the
    // stored record -- the chat silently went back to Claude Code, on a
    // native session id that was OpenCode's.
    root = await mkdtemp(join(tmpdir(), 'clikcode-write-'));
    process.env.CLIKCODE_HOME = root;
    const now = new Date().toISOString();
    const draft = {
      id: 'd', route: 'local', accountId: null, provider: 'anthropic', nativeHarness: 'claude', model: 'opus', effort: 'medium',
      permissionMode: 'ask', createdAt: now, updatedAt: now, status: 'active', messages: [],
    } as HarnessSession;
    const opening = await readState();
    opening.sessions.push(draft);
    await writeState(opening); // blank: held in this process only
    const slow = await readState();
    expect(slow.sessions.find((item) => item.id === 'd')?.nativeHarness).toBe('claude');

    // Another process stores the conversation, now on OpenCode with a turn.
    const { dropEphemeral } = await import('../ephemeral.js');
    dropEphemeral('d');
    const other = await readState();
    other.sessions.push({
      ...draft, provider: 'opencode', nativeHarness: 'opencode', model: 'opencode/big-pickle', nativeSessionId: 'ses_1',
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'PONG' }],
    } as HarnessSession);
    await writeState(other);

    // The slow reader writes what it changed: something else entirely.
    slow.globalSettings = { ...slow.globalSettings, effort: 'high' } as typeof slow.globalSettings;
    await writeState(slow);

    const stored = (await readState()).sessions.find((item) => item.id === 'd')!;
    expect({ harness: stored.nativeHarness, model: stored.model, native: stored.nativeSessionId }).toEqual({ harness: 'opencode', model: 'opencode/big-pickle', native: 'ses_1' });
    expect(stored.messages).toEqual([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'PONG' }]);
  });
});

describe('a streaming turn on a chat read from disk', () => {
  it('writes only its journal while the answer grows, never the transcript again', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-write-'));
    process.env.CLIKCODE_HOME = root;
    const state = await readState();
    const now = new Date().toISOString();
    state.sessions.push({
      id: 's', route: 'gateway', accountId: null, provider: 'gateway', model: null, effort: 'platform-managed', permissionMode: 'bypass',
      createdAt: now, updatedAt: now, status: 'active',
      messages: Array.from({ length: 50 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: `message ${index}` })),
    } as HarnessSession);
    await writeState(state);
    // A worker's copy: read from disk, as it starts the turn.
    resetSessionStoreCache();
    const worker = await readState({ transcripts: ['s'] });
    const session = worker.sessions.find((item) => item.id === 's')!;
    const checkpoint = await DurableTurnCheckpoint.start(worker, session, 'go');
    const transcript = join(root, 'sessions', 's.json');
    const started = (await stat(transcript)).mtimeMs;
    for (let step = 0; step < 3; step++) {
      checkpoint.response(`part ${step} `);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect((await stat(transcript)).mtimeMs, `checkpoint ${step}`).toBe(started);
    }
    resetSessionStoreCache();
    const stored = (await readState({ transcripts: ['s'] })).sessions.find((item) => item.id === 's')!;
    expect(stored.pendingTurn?.response).toBe('part 0 part 1 part 2 ');
    await checkpoint.complete('');
    resetSessionStoreCache();
    const finished = (await readState({ transcripts: ['s'] })).sessions.find((item) => item.id === 's')!;
    expect(finished.messages?.at(-1)?.content.trim()).toBe('part 0 part 1 part 2');
  });
});
