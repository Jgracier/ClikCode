import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { resetHarnessStateCaches } from '../session/state/index-file.js';
import type { HarnessSession } from '../session/model.js';
import { DurableTurnCheckpoint } from './turn-journal.js';

/** A streaming turn writes its journal to `sessions/<id>.turn`; builds that
 * predate that file read `sessions/<id>.json` alone (store/records.ts). These
 * read that file the way such a build does -- the whole of it, nothing else --
 * and write it the way such a build does, never touching `<id>.turn`. */
const previousHome = process.env.CLIKCODE_HOME;
let root = '';
afterEach(async () => {
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
  resetHarnessStateCaches();
  if (root) await rm(root, { recursive: true, force: true });
});

const transcriptPath = (): string => join(root, 'sessions', 's.json');
const turnPath = (): string => join(root, 'sessions', 's.turn');
const oldRead = async (): Promise<{ messages?: Array<{ role: string; content: string }>; pendingTurn?: NonNullable<HarnessSession['pendingTurn']> }> =>
  JSON.parse(await readFile(transcriptPath(), 'utf8'));
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300));

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
  return { checkpoint: await DurableTurnCheckpoint.start(state, session, 'go', undefined), session };
}

describe('a streaming turn, read by a build that knows only <id>.json', () => {
  it('sees the turn running with its prompt and steers while it streams, and the finished answer after', async () => {
    const { checkpoint } = await started();
    checkpoint.response('part one ');
    await tick();
    const during = await oldRead();
    expect(during.pendingTurn).toMatchObject({ prompt: 'go' });
    expect(during.messages?.map((message) => message.content)).toEqual(['earlier', 'yes']);

    // Anything else written during the turn carries the journal as it is now.
    await checkpoint.steer({ id: 'st', text: 'also this', submittedAt: new Date().toISOString() } as never);
    const steered = await oldRead();
    expect(steered.pendingTurn?.steers?.map((steer) => steer.text)).toEqual(['also this']);
    expect(steered.pendingTurn?.response).toBe('part one ');

    checkpoint.response('part two');
    await tick();
    await checkpoint.complete('part one part two');
    const after = await oldRead();
    expect(after.pendingTurn).toBeUndefined();
    // The steer splits the answer where it landed.
    expect(after.messages?.slice(2).map((message) => message.content.trim())).toEqual(['go', 'part one', 'also this', 'part two']);
    await expect(stat(turnPath())).rejects.toThrow();
  });

  it('keeps the streamed journal when such a build rewrites <id>.json mid-turn, and drops it when that build ends the turn', async () => {
    const { checkpoint } = await started();
    checkpoint.response('streamed');
    await tick();
    // An older build appends a message elsewhere in the file and stores it back.
    const file = await oldRead();
    await writeFile(transcriptPath(), JSON.stringify({ ...file, messages: [...file.messages!, { role: 'user', content: 'from an old window' }] }));
    resetHarnessStateCaches();
    const merged = (await readState()).sessions.find((item) => item.id === 's')!;
    expect(merged.pendingTurn?.response).toBe('streamed');
    expect(merged.messages?.at(-1)?.content).toBe('from an old window');

    // That build then ends the turn (it removes the journal; <id>.turn stays).
    const { pendingTurn: _ended, ...rest } = await oldRead();
    await writeFile(transcriptPath(), JSON.stringify(rest));
    resetHarnessStateCaches();
    expect((await readState()).sessions.find((item) => item.id === 's')?.pendingTurn).toBeUndefined();
    await checkpoint.flush();
  });

  it('ignores a leftover journal from another turn', async () => {
    const { checkpoint } = await started();
    await writeFile(turnPath(), JSON.stringify({ prompt: 'go', startedAt: '2000-01-01T00:00:00.000Z', updatedAt: '2999-01-01T00:00:00.000Z', outputStarted: true, response: 'stale' }));
    resetHarnessStateCaches();
    const read = (await readState()).sessions.find((item) => item.id === 's')!;
    expect(read.pendingTurn?.prompt).toBe('go');
    expect(read.pendingTurn?.response).toBeUndefined();
    await checkpoint.complete('done');
  });
});
