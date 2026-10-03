import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessSession } from '../model.js';
import { readState } from './read.js';
import { writeState } from './write.js';
import { runChild } from './testing/concurrency.js';
import { listStoredSessionIds } from '../store/records.js';

const now = () => new Date().toISOString();
const message = (content: string, role: 'user' | 'assistant' = 'user') => ({ role, content });
function chat(id: string, messages: Array<{ role: 'user' | 'assistant'; content: string }>, extra: Partial<HarnessSession> = {}): HarnessSession {
  return {
    id, route: 'gateway', accountId: null, provider: 'gateway', model: null, effort: 'platform-managed', permissionMode: 'bypass',
    accountFailover: 'never', createdAt: now(), updatedAt: now(), status: 'active', messages, ...extra,
  } as HarnessSession;
}

async function freshHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'clikcode-concurrency-home-'));
  process.env.CLIKCODE_HOME = home;
  return home;
}

describe('separate processes writing related chats', () => {
  it('a fork child appended to while its parent is rewritten: both finish, nothing lost', async () => {
    const home = await freshHome();
    const state = await readState();
    const history = [message('a'), message('b', 'assistant'), message('c'), message('d', 'assistant')];
    state.sessions.push(chat('p', history), chat('c', [...history, message('child')], { parentSessionId: 'p' }));
    await writeState(state);

    const results = await Promise.all([
      runChild(home, ['rewrite', 'p', 'parent', '25']),
      runChild(home, ['append-fresh', 'c', 'more', '25']),
      runChild(home, ['rewrite', 'p', 'parent2', '25']),
    ]);
    for (const result of results) expect(result, result.stderr).toMatchObject({ code: 0 });
    const stored = (await readState()).sessions.find((item) => item.id === 'c')!;
    expect(stored.messages!.map((item) => item.content)).toEqual([
      ...history.map((item) => item.content), 'child', ...Array.from({ length: 25 }, (_, step) => `more ${step}`),
    ]);
  }, 120_000);
});

describe('one process writing the same state twice at once', () => {
  it('the later write is what stays on disk (300 runs)', async () => {
    await freshHome();
    const state = await readState();
    const session = chat('s', [message('start')]);
    state.sessions.push(session);
    await writeState(state);
    let wrong = 0;
    for (let run = 0; run < 300; run += 1) {
      session.messages = [...session.messages!, message(`older ${run}`)];
      const older = writeState(state);
      session.messages = [...session.messages, message(`newer ${run}`)];
      const newer = writeState(state);
      await Promise.all([older, newer]);
      const stored = (await readState()).sessions.find((item) => item.id === 's')!;
      if (stored.messages!.at(-1)!.content !== `newer ${run}`) wrong += 1;
    }
    expect(wrong).toBe(0);
  }, 120_000);
});

describe('a chat deleted by one process', () => {
  it('stays deleted when another process with an older snapshot changes it', async () => {
    await freshHome();
    const setup = await readState();
    setup.sessions.push(chat('x', [message('hello'), message('hi', 'assistant')]), chat('y', [message('other')]));
    await writeState(setup);

    const deleter = await readState();
    const stale = await readState();
    deleter.sessions = deleter.sessions.filter((item) => item.id !== 'x');
    await writeState(deleter);

    const kept = stale.sessions.find((item) => item.id === 'x')!;
    kept.title = 'renamed in the stale window';
    kept.messages = [...kept.messages!, message('late')];
    stale.sessions.find((item) => item.id === 'y')!.title = 'still applied';
    await writeState(stale);
    // And again: the stale copy keeps writing, it still stays deleted.
    kept.title = 'again';
    await writeState(stale);

    const after = await readState();
    expect(after.sessions.map((item) => item.id)).toEqual(['y']);
    expect(after.sessions[0]!.title).toBe('still applied');
    expect(await listStoredSessionIds()).toEqual(['y']);
  });
});
