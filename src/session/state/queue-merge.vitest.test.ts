/** The queue is merged message by message: a message one process took out
 * stays out when another process, which still remembered it, writes. */
import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessSession } from '../model.js';
import { readState } from './read.js';
import { writeState } from './write.js';
import { mergeQueuedTurns } from './merge.js';

const at = new Date().toISOString();
const queued = (id: string, text = id) => ({ id, text, submittedAt: at });

describe('mergeQueuedTurns', () => {
  it('keeps what the writer did not touch from disk, drops what it removed, adds what it added', () => {
    const merged = mergeQueuedTurns([queued('a'), queued('b')], [queued('a'), queued('b'), queued('c')], [queued('a'), queued('d')]);
    expect(merged.map((item) => item.id)).toEqual(['a', 'd', 'c']);
  });
  it('a message the writer removed stays removed even though disk still has it', () => {
    expect(mergeQueuedTurns([queued('a'), queued('b')], [queued('a')], [queued('a'), queued('b')]).map((item) => item.id)).toEqual(['a']);
  });
});

describe('a turn that writes its own copy of the session', () => {
  it('does not bring back a queued message another process took out', async () => {
    process.env.CLIKCODE_HOME = await mkdtemp(join(tmpdir(), 'clikcode-queue-merge-'));
    const seed = await readState();
    seed.sessions.push({
      id: 's', route: 'gateway', accountId: null, provider: 'gateway', model: null, effort: 'platform-managed', permissionMode: 'bypass',
      createdAt: at, updatedAt: at, status: 'active', messages: [], queuedTurns: [queued('first')],
    } as HarnessSession);
    await writeState(seed);
    // The running turn's copy, and another process's.
    const turn = await readState({ transcripts: ['s'] });
    const other = await readState({ transcripts: ['s'] });
    // The other process takes the first message back.
    other.sessions.find((item) => item.id === 's')!.queuedTurns = [];
    await writeState(other);
    // The turn then queues a second one and writes its whole copy.
    const mine = turn.sessions.find((item) => item.id === 's')!;
    mine.queuedTurns = [...(mine.queuedTurns ?? []), queued('second')];
    await writeState(turn);
    const stored = (await readState()).sessions.find((item) => item.id === 's')!;
    expect((stored.queuedTurns ?? []).map((item) => item.id)).toEqual(['second']);
  });
});
