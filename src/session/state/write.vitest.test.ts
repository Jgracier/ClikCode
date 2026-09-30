import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState } from './read.js';
import { writeState } from './write.js';
import { STATE_BASELINE, type BaselinedState } from './merge.js';
import { resetSessionStoreCache } from '../store/records.js';
import type { HarnessSession } from '../model.js';
import { listStoredSessionIds } from '../store/records.js';

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
      accountFailover: 'never', createdAt: now, updatedAt: now, status: 'active', messages: [{ role: 'user', content: 'hello' }],
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
      accountFailover: 'never', createdAt: now, updatedAt: now, status: 'active',
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
      accountFailover: 'never', createdAt: now, updatedAt: now, status: 'active', messages: [{ role: 'user', content }],
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

  it('records a turn in flight without its response, and a growing response leaves that record alone', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-list-turn-'));
    process.env.CLIKCODE_HOME = root;
    const state = await readState();
    const now = new Date().toISOString();
    const session = {
      id: 's', route: 'gateway', accountId: null, provider: 'gateway', model: null, effort: 'platform-managed', permissionMode: 'bypass',
      accountFailover: 'never', createdAt: now, updatedAt: now, status: 'active',
      messages: [{ role: 'user', content: 'hello' }],
      pendingTurn: { prompt: 'go', response: 'partial', startedAt: now, updatedAt: now, outputStarted: true },
    } as HarnessSession;
    state.sessions.push(session);
    await writeState(state);
    const loaded = await readState();
    await writeState(loaded);
    resetSessionStoreCache();
    const light = await readState({ transcripts: [] });
    expect(light.sessions[0]?.listTurn).toEqual({ startedAt: now, prompt: 'go' });
    expect(light.sessions[0]?.listPreview).toBe('hello');
    const again = await readState();
    again.sessions[0]!.pendingTurn!.response += ' more';
    again.sessions[0]!.pendingTurn!.updatedAt = new Date(Date.parse(now) + 1000).toISOString();
    await writeState(again);
    resetSessionStoreCache();
    const after = await readState({ transcripts: [] });
    expect(after.sessions[0]?.listTurn).toEqual({ startedAt: now, prompt: 'go' });
    expect(JSON.stringify(after.sessions[0]?.listTurn)).not.toContain('partial');
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
      permissionMode: 'ask', accountFailover: 'never', createdAt: now, updatedAt: now, status: 'active',
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
