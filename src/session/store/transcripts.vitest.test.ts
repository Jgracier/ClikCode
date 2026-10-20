import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState } from '../state/read.js';
import { writeState, writeTranscriptCheckpoint } from '../state/write.js';
import { resetHarnessStateCaches } from '../state/index-file.js';
import type { HarnessSession } from '../model.js';
import { parseChatLog } from './chat-log.js';

const previousHome = process.env.CLIKCODE_HOME;
let root = '';
afterEach(async () => {
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
  resetHarnessStateCaches();
  if (root) await rm(root, { recursive: true, force: true });
});

const now = new Date().toISOString();
const chat = (id: string, messages: HarnessSession['messages'], extra: Partial<HarnessSession> = {}): HarnessSession => ({
  id, route: 'gateway', accountId: null, provider: 'gateway', model: null, effort: 'platform-managed', permissionMode: 'bypass',
createdAt: now, updatedAt: now, status: 'active', messages, ...extra,
} as HarnessSession);
const said = (count: number, prefix = 'm') => Array.from({ length: count }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: `${prefix}${index}` }));
// The chat's own log, parsed as the store parses it.
const log = async (id: string) => parseChatLog(await readFile(join(root, 'sessions', `${id}.jsonl`), 'utf8'));

// Layout adapted (2026-10-20): a fork used to be stored as a reference into its
// parent's `<id>.json` (transcriptRef); in the message log it holds its own
// copy (copy on fork). The behavior asserted -- what reads back, what streams
// where, what survives the parent's rewrite and another writer -- is the same.
describe('a fork of another chat', () => {
  it('holds its own copy through streamed checkpoints and reads back whole', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-fork-'));
    process.env.CLIKCODE_HOME = root;
    const state = await readState();
    state.sessions.push(chat('p', said(6)));
    await writeState(state);
    const child = chat('c', [...said(6), { role: 'user', content: 'forked' }], { parentSessionId: 'p', fork: true });
    state.sessions.push(child);
    await writeState(state);
    child.pendingTurn = { prompt: 'go', startedAt: now, updatedAt: now, outputStarted: true, response: '' };
    await writeState(state);
    for (let step = 0; step < 3; step++) {
      child.pendingTurn.response += `part${step} `;
      expect(await writeTranscriptCheckpoint(state, 'c')).toBe(true);
      const stored = await log('c');
      expect(stored.messages).toEqual(child.messages);
      // The streamed answer goes to the turn's own file; the log keeps
      // the journal as the turn started.
      expect(stored.pending!.response).toBe('');
      const turn = JSON.parse(await readFile(join(root, 'sessions', 'c.pending'), 'utf8'));
      expect(turn.response).toBe(child.pendingTurn.response);
    }
    resetHarnessStateCaches();
    const read = (await readState()).sessions.find((item) => item.id === 'c')!;
    expect(read.messages).toEqual(child.messages);
    expect(read.pendingTurn?.response).toBe('part0 part1 part2 ');
  });

  it('keeps the child whole when the parent\'s history is rewritten, and merges another writer\'s append', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-fork-'));
    process.env.CLIKCODE_HOME = root;
    const state = await readState();
    state.sessions.push(chat('p', said(6)));
    const child = chat('c', [...said(6), { role: 'user', content: 'forked' }], { parentSessionId: 'p', fork: true });
    state.sessions.push(child);
    await writeState(state);
    await writeState(state);
    expect((await log('c')).messages).toEqual(child.messages);

    // Another process appends to the child meanwhile.
    const other = await readState();
    const theirs = other.sessions.find((item) => item.id === 'c')!;
    // A history as read is frozen: a writer replaces it.
    expect(() => theirs.messages!.push({ role: 'assistant', content: 'in place' })).toThrow(TypeError);
    theirs.messages = [...theirs.messages!, { role: 'assistant', content: 'from elsewhere' }];
    await writeState(other);

    // This one undoes the parent's last exchange: the child must not change.
    const parent = state.sessions.find((item) => item.id === 'p')!;
    const childLog = await stat(join(root, 'sessions', 'c.jsonl'));
    parent.messages = parent.messages!.slice(0, 4);
    await writeState(state);
    // The parent's rewrite never touches the child's file.
    expect(await stat(join(root, 'sessions', 'c.jsonl'))).toMatchObject({ ino: childLog.ino, size: childLog.size, mtimeMs: childLog.mtimeMs });

    // And appends to the child from its own (older) copy.
    child.messages = [...child.messages!, { role: 'assistant', content: 'from here' }];
    await writeState(state);
    resetHarnessStateCaches();
    const read = await readState();
    expect(read.sessions.find((item) => item.id === 'p')!.messages).toEqual(said(4));
    expect(read.sessions.find((item) => item.id === 'c')!.messages).toEqual([
      ...said(6), { role: 'user', content: 'forked' }, { role: 'assistant', content: 'from elsewhere' }, { role: 'assistant', content: 'from here' },
    ]);
  });
});
