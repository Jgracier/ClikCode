import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessSession } from '../model.js';
import { readState } from './read.js';
import { writeState } from './write.js';
import { runChild } from './testing/concurrency.js';
import { listStoredSessionIds } from '../store/records.js';
import { STORED_BLANK_GRACE_MS, discardIfBlank } from '../blank.js';
import { backfillListFacts } from '../list-backfill.js';
import { openConversation } from '../attach.js';

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
    state.sessions.push(chat('p', history), chat('c', [...history, message('child')], { parentSessionId: 'p', fork: true }));
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

describe('two processes appending to one chat', () => {
  it('keeps every message from both, each side in its own order', async () => {
    const home = await freshHome();
    const setup = await readState();
    setup.sessions.push(chat('s', [message('start')]));
    await writeState(setup);

    const results = await Promise.all([
      runChild(home, ['append-held', 's', 'a', '30']),
      runChild(home, ['append-held', 's', 'b', '30']),
    ]);
    for (const result of results) expect(result, result.stderr).toMatchObject({ code: 0 });
    const contents = (await readState()).sessions.find((item) => item.id === 's')!.messages!.map((item) => item.content);
    expect(contents[0]).toBe('start');
    expect(contents.filter((text) => text.startsWith('a '))).toEqual(Array.from({ length: 30 }, (_, step) => `a ${step}`));
    expect(contents.filter((text) => text.startsWith('b '))).toEqual(Array.from({ length: 30 }, (_, step) => `b ${step}`));
    expect(contents).toHaveLength(61);
  }, 120_000);

  it('a rewrite (undo) from a stale copy keeps the messages appended meanwhile', async () => {
    await freshHome();
    const setup = await readState();
    setup.sessions.push(chat('s', [message('q1'), message('a1', 'assistant'), message('q2'), message('a2', 'assistant')]));
    await writeState(setup);
    const appender = await readState();
    const undoer = await readState();
    const appended = appender.sessions[0]!;
    appended.messages = [...appended.messages!, message('q3')];
    await writeState(appender);
    const undone = undoer.sessions[0]!;
    undone.messages = undone.messages!.slice(0, 2);
    await writeState(undoer);
    expect((await readState()).sessions[0]!.messages!.map((item) => item.content)).toEqual(['q1', 'a1', 'q3']);
  });
});

describe('an empty chat another process stored for its worker', () => {
  it('survives every blank-chat sweep here; an old leftover does not', async () => {
    const home = await freshHome();
    const setup = await readState();
    setup.sessions.push(chat('kept', [message('hi')]));
    await writeState(setup);
    const old = await runChild(home, ['store-blank', 'leftover']);
    expect(old, old.stderr).toMatchObject({ code: 0 });
    // Age the leftover past the grace period, as an older build's would be.
    const aging = await readState();
    aging.sessions.find((item) => item.id === 'leftover')!.updatedAt = new Date(Date.now() - STORED_BLANK_GRACE_MS - 60_000).toISOString();
    await writeState(aging);
    const fresh = await runChild(home, ['store-blank', 'for-worker']);
    expect(fresh, fresh.stderr).toMatchObject({ code: 0 });

    await backfillListFacts();
    await openConversation('/work', 'new');
    await discardIfBlank('for-worker');
    const ids = (await readState({ transcripts: [] })).sessions.map((item) => item.id);
    expect(ids).toContain('for-worker');
    expect(ids).toContain('kept');
    expect(ids).not.toContain('leftover');
  }, 60_000);
});
