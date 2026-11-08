import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessSession, TranscriptMessage } from './model.js';
import { applyRepair, auditConversations, layAgainst, mergeEvidence, parseRecordMarkdown, planRepair } from './audit.js';
import { writeFullRecord } from './full-record.js';
import { readState } from './state/read.js';
import { writeState } from './state/write.js';
import { resetHarnessStateCaches } from './state/index-file.js';
import { readSessionTranscript } from './store/transcripts.js';
import { resetChatLogCache, writeChatLog } from './store/chat-log.js';
import { stateDirectory } from './store/paths.js';

const stamp = new Date().toISOString();
const ask = (n: number) => `request ${n}: change the module number ${n} so that it handles the new case`;
/** `from`..`to` exchanges of a conversation. */
const turns = (from: number, to: number): TranscriptMessage[] => Array.from({ length: to - from + 1 }, (_, index) => [
  { role: 'user' as const, content: ask(from + index) },
  { role: 'assistant' as const, content: `done ${from + index}` },
]).flat();
const chat = (id: string, messages: TranscriptMessage[]): HarnessSession => ({
  id, route: 'gateway', accountId: null, provider: 'gateway', model: null, effort: 'platform-managed', permissionMode: 'bypass',
  createdAt: stamp, updatedAt: stamp, status: 'active', messages, workspace: '/w', name: 'Long chat',
} as HarnessSession);
const users = (messages: ReadonlyArray<{ role: string }>) => messages.filter((message) => message.role === 'user').length;

describe('laying evidence against a store', () => {
  it('agrees when they share requests, and counts the ones the store lacks', () => {
    expect(layAgainst(turns(1, 10), turns(1, 40))).toEqual({ agrees: true, missing: 30 });
    // The same words in an unrelated conversation share nothing.
    expect(layAgainst(turns(1, 10), turns(101, 140))).toEqual({ agrees: false, missing: 0 });
    expect(layAgainst([], turns(1, 4))).toEqual({ agrees: true, missing: 4 });
  });

  it('reads a saved record back as the messages it was made from', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clikcode-audit-record-'));
    const path = await writeFullRecord(chat('r', turns(1, 5)), root);
    const text = await readFile(path!, 'utf8');
    expect(parseRecordMarkdown(text).map((message) => message.content)).toEqual(turns(1, 5).map((message) => message.content));
  });
});

describe('the conversation as the evidence has it', () => {
  const rich = (n: number): TranscriptMessage[] => turns(n, n).map((message) => ({ ...message, origin: { harness: 'claude' } } as TranscriptMessage));

  it('takes the record as the backbone, keeps the store\'s own turns where it has them, and adds what only the store has, last', () => {
    const record = { source: 'record' as const, path: 'r.md', at: '2026-11-06T17:50:00.000Z', messages: turns(1, 20) };
    // A store restored to turn 5, then carried on past the record's end.
    const store = { source: 'store' as const, path: 's.jsonl', at: '2026-11-08T01:00:00.000Z', messages: [...rich(1), ...rich(2), ...rich(3), ...rich(4), ...rich(5), ...turns(21, 22)] };
    const merged = mergeEvidence([record, store]);
    expect(users(merged.messages)).toBe(22);
    expect(merged.messages.map((message) => message.content)).toEqual(turns(1, 22).map((message) => message.content));
    // The store's richer turns stand in the first five; the record's text for the rest.
    expect((merged.messages[0] as TranscriptMessage).origin).toEqual({ harness: 'claude' });
    expect((merged.messages[12] as TranscriptMessage).origin).toBeUndefined();
    expect(merged.steps.map((step) => step.source)).toEqual(['record', 'store']);
  });

  it('leaves an older piece out: a thread written before the backbone adds nothing', () => {
    const record = { source: 'record' as const, path: 'r.md', at: '2026-11-06T17:50:00.000Z', messages: turns(1, 20) };
    const old = { source: 'claude-thread' as const, path: 't.jsonl', at: '2026-10-12T00:00:00.000Z', messages: [...turns(1, 8), ...turns(90, 95)] };
    expect(users(mergeEvidence([record, old]).messages)).toBe(20);
  });
});

describe('sessions audit and repair, on a store that fell behind its record', () => {
  let root = '';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-audit-'));
    process.env.CLIKCODE_HOME = root;
    resetHarnessStateCaches();
    resetChatLogCache();
  });

  async function behind(): Promise<void> {
    const state = await readState();
    state.sessions.push(chat('c', turns(1, 60)), chat('fine', turns(1, 4)));
    await writeState(state);
    // The handoff that saved the whole conversation...
    await writeFullRecord(chat('c', turns(1, 60)), stateDirectory());
    // ...and a store put back to turn 10 (a restored snapshot): the log, and the row that describes it.
    await writeChatLog('c', { messages: turns(1, 10) });
    resetHarnessStateCaches();
    resetChatLogCache();
    const reread = await readState({ transcripts: ['c'] });
    await writeState(reread);
  }

  it('finds it, and a dry run changes nothing', async () => {
    await behind();
    const audit = await auditConversations();
    const entry = audit.find((item) => item.id === 'c')!;
    expect(entry).toMatchObject({ status: 'behind', behindBy: 50, store: { userTurns: 10 } });
    expect(entry.evidence.find((item) => item.source === 'record')).toMatchObject({ userTurns: 60, beyondStore: 50, aligned: true });
    expect(audit.find((item) => item.id === 'fine')!.status).toBe('ok');

    const before = await readdir(join(root, 'sessions'));
    const plan = await planRepair('c');
    expect(plan.to.userTurns).toBe(60);
    expect(plan.from).toMatchObject({ userTurns: 10 });
    expect(await readdir(join(root, 'sessions'))).toEqual(before);
    expect(existsSync(join(root, 'repair-backups'))).toBe(false);
  });

  it('applies by copying what the conversation has first, then writing the log, and the audit then finds nothing', async () => {
    await behind();
    const done = await applyRepair(await planRepair('c'));
    expect(done.backedUp).toEqual(expect.arrayContaining(['c.jsonl']));
    expect(await readdir(done.backup)).toEqual(expect.arrayContaining(['c.jsonl']));
    resetHarnessStateCaches();
    resetChatLogCache();
    expect(users((await readSessionTranscript('c')).messages!)).toBe(60);
    const row = (await readState()).sessions.find((item) => item.id === 'c')!;
    expect(row.listMessageCount).toBe(120);
    expect((await auditConversations()).find((item) => item.id === 'c')!.status).toBe('ok');
  });

  it('rebuilds a conversation whose log is gone, from its record, and says so beforehand', async () => {
    await behind();
    await unlink(join(root, 'sessions', 'c.jsonl'));
    resetChatLogCache();
    expect((await auditConversations()).find((item) => item.id === 'c')).toMatchObject({ status: 'log-missing', store: null });
    const plan = await planRepair('c');
    expect(plan.from).toBeNull();
    await applyRepair(plan);
    resetChatLogCache();
    expect(users((await readSessionTranscript('c')).messages!)).toBe(60);
  });

  it('refuses when nothing in the evidence extends the conversation', async () => {
    const state = await readState();
    state.sessions.push(chat('alone', turns(1, 6)));
    await writeState(state);
    await expect(applyRepair(await planRepair('alone'))).rejects.toThrow(/nothing in the evidence extends/);
  });

  async function claudeThread(id: string, from: number, to: number): Promise<void> {
    const dir = join(root, 'profiles', 'claude', 'p1', 'projects', '-w');
    await mkdir(dir, { recursive: true });
    const lines = turns(from, to).map((message, index) => JSON.stringify(message.role === 'user'
      ? { type: 'user', uuid: `u${index}`, timestamp: stamp, message: { role: 'user', content: message.content } }
      : { type: 'assistant', uuid: `a${index}`, timestamp: stamp, message: { role: 'assistant', content: [{ type: 'text', text: message.content }] } }));
    await writeFile(join(dir, `${id}.jsonl`), lines.join('\n'));
  }

  it('takes a thread that merely opens with the same request for advice, and one the row names for evidence', async () => {
    const state = await readState();
    state.sessions.push(chat('x', turns(1, 10)));
    await writeState(state);
    await claudeThread('thread-1', 1, 40);
    expect(await auditConversations(['x'])).toMatchObject([{ status: 'possibly-behind', behindBy: 0, possiblyBehindBy: 30 }]);
    // Named by the conversation's own row: it is its thread.
    const named = await readState({ transcripts: ['x'] });
    Object.assign(named.sessions.find((item) => item.id === 'x')!, { nativeHarness: 'claude', nativeSessionId: 'thread-1' });
    await writeState(named);
    expect(await auditConversations(['x'])).toMatchObject([{ status: 'behind', behindBy: 30 }]);
    const plan = await planRepair('x');
    expect(plan).toMatchObject({ to: { userTurns: 40 }, steps: [{ source: 'claude-thread' }] });
  });
});
