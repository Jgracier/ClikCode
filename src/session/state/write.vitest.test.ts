import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState } from './read.js';
import { writeState } from './write.js';
import type { HarnessSession } from '../model.js';

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
