import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { resetHarnessStateCaches } from '../session/state/index-file.js';
import type { HarnessSession } from '../session/model.js';
import { parseChatLog } from '../session/store/chat-log.js';
import { DurableTurnCheckpoint } from './turn-journal.js';

/** A chat this build starts lives in its message log, `sessions/<id>.jsonl`,
 * with the streaming journal in `<id>.pending`; builds that predate the log
 * read `sessions/<id>.json` alone (store/transcripts.ts, the mixed-build
 * rule). These read and write that file the way such a build does -- the
 * whole of it, nothing else.
 *
 * Contract changed on purpose (2026-10-20): such a build used to see this
 * build's running turn in `<id>.json`, which therefore had to be rewritten
 * whole at every turn's start, steer and end. It now sees a note that the
 * chat moved; what it writes into `<id>.json` is still taken in here. */
const previousHome = process.env.CLIKCODE_HOME;
let root = '';
afterEach(async () => {
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
  resetHarnessStateCaches();
  if (root) await rm(root, { recursive: true, force: true });
});

const transcriptPath = (): string => join(root, 'sessions', 's.json');
const pendingPath = (): string => join(root, 'sessions', 's.pending');
const oldRead = async (): Promise<{ messages?: Array<{ role: string; content: string }>; pendingTurn?: NonNullable<HarnessSession['pendingTurn']> }> =>
  JSON.parse(await readFile(transcriptPath(), 'utf8'));
const stored = async () => parseChatLog(await readFile(join(root, 'sessions', 's.jsonl'), 'utf8'));
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300));
const current = async () => { resetHarnessStateCaches(); return (await readState()).sessions.find((item) => item.id === 's')!; };

async function started(): Promise<{ checkpoint: DurableTurnCheckpoint; session: HarnessSession }> {
  root = await mkdtemp(join(tmpdir(), 'clikcode-old-reader-'));
  process.env.CLIKCODE_HOME = root;
  const state = await readState();
  const at = new Date(Date.now() - 60_000).toISOString();
  const session = {
    id: 's', route: 'gateway', accountId: null, provider: 'gateway', model: null, effort: 'platform-managed', permissionMode: 'bypass',
createdAt: at, updatedAt: at, status: 'active', messages: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'yes' }],
  } as HarnessSession;
  state.sessions.push(session);
  await writeState(state);
  const checkpoint = await DurableTurnCheckpoint.start(state, session, 'go', undefined);
  await checkpoint.flush(); // the start write is not awaited by start()
  return { checkpoint, session };
}

describe('a streaming turn, read by a build that knows only <id>.json', () => {
  it('sees a note that the chat moved, which no turn here ever rewrites; the turn is whole in the log', async () => {
    const { checkpoint } = await started();
    const before = await readFile(transcriptPath(), 'utf8');
    expect((await oldRead()).messages).toEqual([expect.objectContaining({ role: 'assistant', storedInLog: true })]);
    expect((await oldRead()).pendingTurn).toBeUndefined();
    checkpoint.response('part one ');
    await tick();
    expect((await stored()).pending).toMatchObject({ prompt: 'go' });
    await checkpoint.steer({ id: 'st', text: 'also this', submittedAt: new Date().toISOString() } as never);
    expect((await stored()).pending?.steers?.map((steer) => steer.text)).toEqual(['also this']);
    checkpoint.response('part two');
    await tick();
    await checkpoint.complete('part one part two');
    expect(await readFile(transcriptPath(), 'utf8')).toBe(before);
    const after = await current();
    expect(after.pendingTurn).toBeUndefined();
    // The steer landed inside a block, so it follows that block whole: never a cut through the
    // middle of a sentence (standard 1.5 / 3; the live view draws it there too).
    expect(after.messages?.map((message) => message.content.trim())).toEqual(['earlier', 'yes', 'go', 'part one part two', 'also this']);
    await expect(stat(pendingPath())).rejects.toThrow();
  });

  it('splits the answer at a steer that landed between blocks', async () => {
    const { checkpoint } = await started();
    checkpoint.response('part one\n\n');
    await tick();
    await checkpoint.steer({ id: 'st', text: 'also this', submittedAt: new Date().toISOString() } as never);
    checkpoint.response('part two');
    await tick();
    await checkpoint.complete('part one\n\npart two');
    const after = await current();
    expect(after.messages?.slice(2).map((message) => message.content.trim())).toEqual(['go', 'part one', 'also this', 'part two']);
  });

  it('takes in a message such a build appends to <id>.json mid-turn, and keeps the streamed journal', async () => {
    const { checkpoint } = await started();
    checkpoint.response('streamed');
    await tick();
    // An older build appends a message to the file it sees and stores it back.
    const file = await oldRead();
    await writeFile(transcriptPath(), JSON.stringify({ ...file, messages: [...file.messages!, { role: 'user', content: 'from an old window' }] }));
    const merged = await current();
    expect(merged.pendingTurn?.response).toBe('streamed');
    expect(merged.messages?.map((message) => message.content)).toEqual(['earlier', 'yes', 'from an old window']);

    // That build never saw this turn, so nothing it writes ends it here.
    const { pendingTurn: _none, ...rest } = await oldRead();
    await writeFile(transcriptPath(), JSON.stringify(rest));
    expect((await current()).pendingTurn?.response).toBe('streamed');
    await checkpoint.complete('streamed, done');
    const done = await current();
    expect(done.messages?.map((message) => message.content)).toEqual(['earlier', 'yes', 'from an old window', 'go', 'streamed, done']);
  });

  it('ignores a leftover journal from another turn', async () => {
    const { checkpoint } = await started();
    for (const name of ['s.pending', 's.turn']) {
      await writeFile(join(root, 'sessions', name), JSON.stringify({ prompt: 'go', startedAt: '2000-01-01T00:00:00.000Z', updatedAt: '2999-01-01T00:00:00.000Z', outputStarted: true, response: 'stale' }));
    }
    const read = await current();
    expect(read.pendingTurn?.prompt).toBe('go');
    expect(read.pendingTurn?.response).toBeUndefined();
    await checkpoint.complete('done');
  });
});

describe('steering a turn', () => {
  it('records the steer and drops its queued copy in one write', async () => {
    const { checkpoint, session } = await started();
    const submission = { id: 'held', text: 'steer me', submittedAt: new Date().toISOString() };
    await checkpoint.queue(submission, { held: true });
    await checkpoint.steer(submission);
    expect((await stored()).pending?.steers).toHaveLength(1);
    expect(session.queuedTurns ?? []).toHaveLength(0);
  });

  it('rejects once the turn is over, so the message is queued instead of lost', async () => {
    const { checkpoint } = await started();
    await checkpoint.complete('done');
    await expect(checkpoint.steer({ id: 'late', text: 'too late', submittedAt: new Date().toISOString() })).rejects.toThrow('turn is finishing');
  });
});
