import { afterEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessSession } from '../model.js';
import { forceStoreSession, unforceStoreSession } from '../ephemeral.js';
import { readState } from '../state/read.js';
import { writeState } from '../state/write.js';
import { resetHarnessStateCaches } from '../state/index-file.js';
import { runChild } from '../state/testing/concurrency.js';
import { chatLogStats, parseChatLog } from './chat-log.js';
import { MIGRATION_FAULTS, readSessionTranscript } from './transcripts.js';
import { listStoredSessionIds } from './records.js';

/** The message log and its migration from `<id>.json` (store/transcripts.ts). */

const previousHome = process.env.CLIKCODE_HOME;
let root = '';
afterEach(async () => {
  delete MIGRATION_FAULTS.at;
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
  resetHarnessStateCaches();
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

type Message = NonNullable<HarnessSession['messages']>[number];
const now = new Date().toISOString();
const said = (count: number, prefix = 'm', size = 0): Message[] => Array.from({ length: count }, (_, index) => ({
  role: index % 2 ? 'assistant' as const : 'user' as const, content: `${prefix}${index}${size ? ` ${'x'.repeat(size)}` : ''}`,
  ...(index % 2 ? { origin: { harness: 'claude', route: 'local' } } : {}),
} as Message));
const row = (id: string, extra: Partial<HarnessSession> = {}): HarnessSession => ({
  id, route: 'gateway', accountId: null, provider: 'gateway', model: null, effort: 'platform-managed', permissionMode: 'bypass',
  createdAt: now, updatedAt: now, status: 'active', ...extra,
} as HarnessSession);
const path = (name: string): string => join(root, 'sessions', name);
const exists = async (name: string): Promise<boolean> => Boolean(await stat(path(name)).catch(() => undefined));
const contents = (messages: readonly Message[] | undefined): string[] => (messages ?? []).map((message) => message.content);

async function home(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'clikcode-log-'));
  process.env.CLIKCODE_HOME = root;
  await readState();
  return root;
}

/** A chat exactly as a build before the log stored it: its index row, and
 * `<id>.json` written whole (compact JSON, `messages` last) -- nothing else. */
async function legacyChat(id: string, file: { messages?: Message[]; pendingTurn?: HarnessSession['pendingTurn']; transcriptRef?: { sessionId: string; uptoIndex: number } }, extra: Partial<HarnessSession> = {}): Promise<string> {
  const state = await readState({ transcripts: [] });
  state.sessions.push(row(id, extra));
  forceStoreSession(id);
  try { await writeState(state); } finally { unforceStoreSession(id); }
  const { messages, ...rest } = file;
  const text = JSON.stringify({ v: 1, id, ...rest, ...(messages ? { messages } : {}) });
  await mkdir(join(root, 'sessions'), { recursive: true, mode: 0o700 });
  await writeFile(path(`${id}.json`), text, { mode: 0o600 });
  resetHarnessStateCaches();
  return text;
}

/** What a build before the log does to `<id>.json`: read it, change it, store it back atomically. */
async function oldBuildWrites(id: string, change: (file: { messages?: Message[]; pendingTurn?: HarnessSession['pendingTurn'] }) => void): Promise<void> {
  const file = JSON.parse(await readFile(path(`${id}.json`), 'utf8'));
  change(file);
  const temporary = `${path(`${id}.json`)}.99999.abc.tmp`;
  await writeFile(temporary, JSON.stringify(file), { mode: 0o600 });
  await rename(temporary, path(`${id}.json`));
}

async function appendHere(id: string, ...added: Message[]): Promise<void> {
  const state = await readState({ transcripts: [id] });
  const session = state.sessions.find((item) => item.id === id)!;
  session.messages = [...(session.messages ?? []), ...added];
  await writeState(state);
}

async function stored(id: string): Promise<HarnessSession> {
  resetHarnessStateCaches();
  return (await readState()).sessions.find((item) => item.id === id)!;
}

describe('a chat in the older format', () => {
  it('is read as it is, forever, without being moved or changed', async () => {
    await home();
    const text = await legacyChat('old', { messages: said(4) });
    for (let read = 0; read < 3; read += 1) expect(contents((await stored('old')).messages)).toEqual(contents(said(4)));
    expect(await readFile(path('old.json'), 'utf8')).toBe(text);
    expect(await exists('old.jsonl')).toBe(false);
  });

  it('moves to the log on its first write here: same history, <id>.json untouched and kept under a second name', async () => {
    await home();
    const text = await legacyChat('old', { messages: said(4), pendingTurn: { prompt: 'p', response: 'r', startedAt: now, updatedAt: now } as HarnessSession['pendingTurn'] });
    const before = await stat(path('old.json'));
    await appendHere('old', { role: 'user', content: 'new here' });
    expect(await readFile(path('old.json'), 'utf8')).toBe(text);
    const backup = await stat(path('old.json-v1'));
    expect({ ino: backup.ino, size: backup.size }).toEqual({ ino: before.ino, size: before.size });
    const log = parseChatLog(await readFile(path('old.jsonl'), 'utf8'));
    expect(log.messages).toEqual([...said(4), { role: 'user', content: 'new here' }]);
    expect(log.pending).toMatchObject({ prompt: 'p', response: 'r' });
    const read = await stored('old');
    expect(contents(read.messages)).toEqual([...contents(said(4)), 'new here']);
    expect(read.pendingTurn?.response).toBe('r');
  });

  it('moves a big chat whole, and then appends without reading or writing its history again', async () => {
    await home();
    const history = said(3_000, 'big', 4_000); // ~12 MB
    const text = await legacyChat('big', { messages: history });
    await appendHere('big', { role: 'user', content: 'first here' });
    expect(await readFile(path('big.json'), 'utf8')).toBe(text);
    const read = await readSessionTranscript('big');
    expect(read.messages).toHaveLength(3_001);
    expect(read.messages!.slice(0, 3_000)).toEqual(history);

    // Warm: appending N messages reads and writes O(N) bytes, not the history.
    const state = await readState({ transcripts: ['big'] });
    const session = state.sessions.find((item) => item.id === 'big')!;
    const size = (await stat(path('big.jsonl'))).size;
    const stats = { ...chatLogStats() };
    for (let step = 0; step < 5; step += 1) {
      session.messages = [...session.messages!, { role: 'user', content: `step ${step}` }];
      await writeState(state);
    }
    await readSessionTranscript('big');
    const after = chatLogStats();
    expect(after.fullReads - stats.fullReads).toBe(0);
    expect(after.rewrites - stats.rewrites).toBe(0);
    expect(after.bytesRead - stats.bytesRead).toBeLessThan(10_000);
    expect((await stat(path('big.jsonl'))).size - size).toBeLessThan(1_000);
    expect(contents((await stored('big')).messages).slice(-5)).toEqual(['step 0', 'step 1', 'step 2', 'step 3', 'step 4']);
  }, 60_000);

  for (const step of ['read', 'write', 'sync', 'verify', 'backup', 'rename'] as const) {
    it(`stays whole in <id>.json when its move fails at "${step}", and moves on the next write`, async () => {
      await home();
      const text = await legacyChat('old', { messages: said(6) });
      // A crash of an earlier attempt left a half-written temporary behind.
      await writeFile(path(`old.jsonl.4242.dead.tmp`), '{"v":2,"gen":"x","id":"old"}\n{"add":[{"role":"us');
      MIGRATION_FAULTS.at = (at) => { if (at === step) throw new Error(`injected at ${at}`); };
      await expect(appendHere('old', { role: 'user', content: 'lost?' })).rejects.toThrow(`injected at ${step}`);
      delete MIGRATION_FAULTS.at;
      expect(await readFile(path('old.json'), 'utf8')).toBe(text);
      expect(await exists('old.jsonl')).toBe(false);
      expect(contents((await stored('old')).messages)).toEqual(contents(said(6)));
      expect((await readdir(join(root, 'sessions'))).filter((name) => name.endsWith('.tmp') && !name.includes('4242'))).toEqual([]);
      await appendHere('old', { role: 'user', content: 'second try' });
      expect(contents((await stored('old')).messages)).toEqual([...contents(said(6)), 'second try']);
      expect(await readFile(path('old.json'), 'utf8')).toBe(text);
    });
  }

  it('is read from the log once the log is in place, even if the write that moved it went no further', async () => {
    await home();
    const text = await legacyChat('old', { messages: said(6) });
    MIGRATION_FAULTS.at = (at) => { if (at === 'placed') throw new Error('injected after the rename'); };
    await expect(appendHere('old', { role: 'user', content: 'not yet' })).rejects.toThrow('injected after the rename');
    delete MIGRATION_FAULTS.at;
    expect(contents(parseChatLog(await readFile(path('old.jsonl'), 'utf8')).messages)).toEqual(contents(said(6)));
    expect(contents((await stored('old')).messages)).toEqual(contents(said(6)));
    expect(await readFile(path('old.json'), 'utf8')).toBe(text);
    await appendHere('old', { role: 'user', content: 'appended' });
    expect(contents((await stored('old')).messages)).toEqual([...contents(said(6)), 'appended']);
  });
});

describe('a log whose last line was cut short', () => {
  it('reads up to the last complete line, never throws, and the next append starts a line of its own', async () => {
    await home();
    const state = await readState();
    state.sessions.push(row('t', { messages: said(3) }));
    await writeState(state);
    await appendFile(path('t.jsonl'), '{"add":[{"role":"user","content":"half a');
    resetHarnessStateCaches();
    expect(contents((await readSessionTranscript('t')).messages)).toEqual(contents(said(3)));
    await appendHere('t', { role: 'user', content: 'after the tear' });
    expect(contents((await stored('t')).messages)).toEqual([...contents(said(3)), 'after the tear']);
    const log = parseChatLog(await readFile(path('t.jsonl'), 'utf8'));
    expect(log.skipped).toBe(1);
    expect(contents(log.messages)).toEqual([...contents(said(3)), 'after the tear']);
  });

  it('skips a damaged line in the middle and keeps every other record', async () => {
    await home();
    const state = await readState();
    state.sessions.push(row('d', { messages: said(2) }));
    await writeState(state);
    await appendFile(path('d.jsonl'), 'not json at all\n{"add":[{"role":"user","content":"kept"}]}\n');
    resetHarnessStateCaches();
    expect(contents((await readSessionTranscript('d')).messages)).toEqual([...contents(said(2)), 'kept']);
  });
});

describe('a build that predates the log', () => {
  it('sees a chat born here as a note, which this build never shows', async () => {
    await home();
    const state = await readState();
    state.sessions.push(row('born', { messages: said(2) }));
    await writeState(state);
    const stub = JSON.parse(await readFile(path('born.json'), 'utf8'));
    expect(stub.messages).toHaveLength(1);
    expect(stub.messages[0]).toMatchObject({ role: 'assistant', storedInLog: true });
    expect(contents((await stored('born')).messages)).toEqual(contents(said(2)));
  });

  it('writes after the chat moved: its appends and its turn are taken in, once, and nothing is lost', async () => {
    await home();
    await legacyChat('mixed', { messages: said(4) });
    await appendHere('mixed', { role: 'user', content: 'new 1' });
    // The older build appends to the file it knows and runs a turn there.
    await oldBuildWrites('mixed', (file) => {
      file.messages!.push({ role: 'user', content: 'old 1' }, { role: 'assistant', content: 'old answer 1' });
      file.pendingTurn = { prompt: 'old prompt', response: 'old streaming', startedAt: now, updatedAt: now } as HarnessSession['pendingTurn'];
    });
    const seen = await stored('mixed');
    expect(contents(seen.messages)).toEqual([...contents(said(4)), 'new 1', 'old 1', 'old answer 1']);
    expect(seen.pendingTurn).toMatchObject({ prompt: 'old prompt', response: 'old streaming' });
    // This build writes again: what the older build wrote is stored in the log first.
    await appendHere('mixed', { role: 'user', content: 'new 2' });
    // The older build ends its turn (it knows nothing of 'new 1' or 'new 2').
    await oldBuildWrites('mixed', (file) => {
      file.messages!.push({ role: 'user', content: 'old prompt' }, { role: 'assistant', content: 'old final' });
      delete file.pendingTurn;
    });
    await appendHere('mixed', { role: 'user', content: 'new 3' });
    const after = await stored('mixed');
    expect(contents(after.messages)).toEqual([...contents(said(4)), 'new 1', 'old 1', 'old answer 1', 'new 2', 'old prompt', 'old final', 'new 3']);
    expect(after.pendingTurn).toBeUndefined();
    // And the log holds it all on its own.
    const log = parseChatLog(await readFile(path('mixed.jsonl'), 'utf8'));
    expect(contents(log.messages)).toEqual(contents(after.messages));
  });

  it('rewrote the history there (an undo): nothing either side holds is lost', async () => {
    await home();
    await legacyChat('undo', { messages: said(6) });
    await appendHere('undo', { role: 'user', content: 'new 1' });
    await oldBuildWrites('undo', (file) => { file.messages = [...file.messages!.slice(0, 2), { role: 'user', content: 'after the old undo' }]; });
    const after = await stored('undo');
    expect(contents(after.messages)).toEqual([...contents(said(6)), 'new 1', 'after the old undo']);
  });

  it('deleted its copy: the chat here is not touched', async () => {
    await home();
    await legacyChat('gone', { messages: said(2) });
    await appendHere('gone', { role: 'user', content: 'new' });
    await rm(path('gone.json'));
    expect(contents((await stored('gone')).messages)).toEqual([...contents(said(2)), 'new']);
    await appendHere('gone', { role: 'user', content: 'again' });
    expect(contents((await stored('gone')).messages)).toEqual([...contents(said(2)), 'new', 'again']);
  });
});

describe('forks', () => {
  it('copies its history, from a moved and from a not-yet-moved parent alike; neither parent is touched', async () => {
    await home();
    await legacyChat('moved', { messages: said(4, 'a') });
    await appendHere('moved', { role: 'user', content: 'moved here' });
    const unmovedText = await legacyChat('unmoved', { messages: said(4, 'b') });
    const state = await readState();
    const from = (id: string) => state.sessions.find((item) => item.id === id)!.messages!;
    state.sessions.push(
      row('fork-a', { parentSessionId: 'moved', fork: true, messages: [...from('moved').slice(0, 3), { role: 'user', content: 'fork a' }] }),
      row('fork-b', { parentSessionId: 'unmoved', fork: true, messages: [...from('unmoved').slice(0, 3), { role: 'user', content: 'fork b' }] }),
    );
    await writeState(state);
    expect(await readFile(path('unmoved.json'), 'utf8')).toBe(unmovedText);
    expect(await exists('unmoved.jsonl')).toBe(false);
    for (const [id, prefix, own] of [['fork-a', 'a', 'fork a'], ['fork-b', 'b', 'fork b']] as const) {
      const log = parseChatLog(await readFile(path(`${id}.jsonl`), 'utf8'));
      expect(contents(log.messages)).toEqual([...contents(said(3, prefix)), own]);
    }
    // The moved parent's history is rewritten: the fork keeps its own.
    const parent = await readState();
    parent.sessions.find((item) => item.id === 'moved')!.messages = said(1, 'a');
    await writeState(parent);
    expect(contents((await stored('fork-a')).messages)).toEqual([...contents(said(3, 'a')), 'fork a']);
    expect(contents((await stored('moved')).messages)).toEqual(contents(said(1, 'a')));
  });

  it('an older-format fork stored as a reference reads through its parent\'s <id>.json, before and after the parent moves, and is given its own copy when the parent is deleted', async () => {
    await home();
    await legacyChat('parent', { messages: said(5, 'p') });
    const childText = await legacyChat('child', { transcriptRef: { sessionId: 'parent', uptoIndex: 4 }, messages: [{ role: 'user', content: 'child own' }] }, { parentSessionId: 'parent', fork: true });
    const expected = [...contents(said(4, 'p')), 'child own'];
    expect(contents((await stored('child')).messages)).toEqual(expected);
    // The parent moves to the log and its history is then rewritten here.
    await appendHere('parent', { role: 'user', content: 'parent new' });
    const parent = await readState();
    parent.sessions.find((item) => item.id === 'parent')!.messages = said(2, 'p');
    await writeState(parent);
    expect(contents((await stored('child')).messages)).toEqual(expected);
    expect(await readFile(path('child.json'), 'utf8')).toBe(childText);
    // The parent is deleted: the child gets its own whole copy first.
    const deleting = await readState();
    deleting.sessions = deleting.sessions.filter((item) => item.id !== 'parent');
    await writeState(deleting);
    expect(await exists('parent.json')).toBe(false);
    expect(await exists('parent.jsonl')).toBe(false);
    expect(await exists('parent.json-v1')).toBe(false);
    expect(JSON.parse(await readFile(path('child.json'), 'utf8')).transcriptRef).toBeUndefined();
    expect(contents((await stored('child')).messages)).toEqual(expected);
    expect((await listStoredSessionIds()).sort()).toEqual(['child']);
  });
});

describe('a directory holding both formats', () => {
  it('reads every chat, each from where it is', async () => {
    await home();
    await legacyChat('legacy', { messages: said(3, 'l') });
    await legacyChat('legacy-fork', { transcriptRef: { sessionId: 'legacy', uptoIndex: 2 }, messages: [{ role: 'user', content: 'lf' }] });
    await legacyChat('moved', { messages: said(2, 'm') });
    await appendHere('moved', { role: 'user', content: 'moved here' });
    const state = await readState();
    state.sessions.push(row('born', { messages: said(2, 'n') }));
    await writeState(state);
    const read = await readState();
    const of = (id: string) => contents(read.sessions.find((item) => item.id === id)?.messages);
    expect(of('legacy')).toEqual(contents(said(3, 'l')));
    expect(of('legacy-fork')).toEqual([...contents(said(2, 'l')), 'lf']);
    expect(of('moved')).toEqual([...contents(said(2, 'm')), 'moved here']);
    expect(of('born')).toEqual(contents(said(2, 'n')));
    expect((await listStoredSessionIds()).sort()).toEqual(['born', 'legacy', 'legacy-fork', 'moved']);
  });
});

describe('separate processes appending', () => {
  it('to two chats and to a fork pair, all still in the older format: every message kept, each side in order', async () => {
    const dir = await home();
    await legacyChat('one', { messages: said(2, 'o') });
    await legacyChat('two', { messages: said(2, 't') });
    await legacyChat('p', { messages: said(4, 'p') });
    await legacyChat('c', { transcriptRef: { sessionId: 'p', uptoIndex: 4 }, messages: [{ role: 'user', content: 'child' }] }, { parentSessionId: 'p', fork: true });
    const results = await Promise.all([
      runChild(dir, ['append-held', 'one', 'a', '20']),
      runChild(dir, ['append-fresh', 'one', 'b', '20']),
      runChild(dir, ['append-held', 'two', 'a', '20']),
      runChild(dir, ['append-fresh', 'p', 'pp', '20']),
      runChild(dir, ['append-held', 'c', 'cc', '20']),
      runChild(dir, ['rewrite', 'p', 'rw', '10']),
    ]);
    for (const result of results) expect(result, result.stderr).toMatchObject({ code: 0 });
    const read = await readState();
    const of = (id: string) => contents(read.sessions.find((item) => item.id === id)?.messages);
    const series = (tag: string, count: number) => Array.from({ length: count }, (_, step) => `${tag} ${step}`);
    expect(of('one').filter((text) => text.startsWith('a '))).toEqual(series('a', 20));
    expect(of('one').filter((text) => text.startsWith('b '))).toEqual(series('b', 20));
    expect(of('one')).toHaveLength(42);
    expect(of('two')).toEqual([...contents(said(2, 't')), ...series('a', 20)]);
    expect(of('p').filter((text) => text.startsWith('pp '))).toEqual(series('pp', 20));
    expect(of('p')).toHaveLength(24);
    expect(of('c')).toEqual([...contents(said(4, 'p')), 'child', ...series('cc', 20)]);
    for (const id of ['one', 'two', 'p', 'c']) expect(await exists(`${id}.jsonl`)).toBe(true);
  }, 120_000);
});
