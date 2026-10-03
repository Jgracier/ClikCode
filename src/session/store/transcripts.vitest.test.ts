import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetSessionStoreCache } from './records.js';
import { readSessionTranscript, writeSessionTranscript } from './transcripts.js';

const previousHome = process.env.CLIKCODE_HOME;
let root: string | undefined;

afterEach(async () => {
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  resetSessionStoreCache();
});

const msg = (content: string) => ({ role: 'user' as const, content });

describe('writeSessionTranscript cross-session locking', () => {
  // Reproduces the exact interleaving that deadlocked: one call chain
  // truncates X's history (which must materialize X's children, including Y)
  // while a second, concurrent call chain is simultaneously forking Y off X
  // (which must lock X as Y's prospective parent). Each chain wants the lock
  // the other is holding. If the two functions ever again acquire the state
  // lock and a session lock in different orders, this hangs instead of
  // resolving -- so a wall-clock timeout is the correct failure mode here.
  it('does not deadlock when one call truncates a session while another forks off it', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-transcripts-'));
    process.env.CLIKCODE_HOME = root;

    const shared = [msg('a'), msg('b'), msg('c')];
    await writeSessionTranscript('x', { messages: shared });
    await writeSessionTranscript('y', { messages: [...shared, msg('d')] }, { parentSessionId: 'x' });
    expect((await readSessionTranscript('y')).messages).toHaveLength(4);

    const truncateX = writeSessionTranscript('x', { messages: [msg('a')] });
    const reforkY = writeSessionTranscript('y', { messages: [...shared, msg('d'), msg('e')] }, { parentSessionId: 'x' });

    await Promise.race([
      Promise.all([truncateX, reforkY]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('deadlocked: did not settle within 2s')), 2000)),
    ]);

    expect((await readSessionTranscript('x')).messages).toEqual([msg('a')]);
    // Whichever write of y "won" -- either is correct, so long as it is one
    // of them and children were never left pointing at truncated history.
    const y = (await readSessionTranscript('y')).messages;
    expect(y?.length).toBeGreaterThan(0);
  });

  it('keeps a plain append on one session independent of a concurrent write on another', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-transcripts-'));
    process.env.CLIKCODE_HOME = root;
    await Promise.all([
      writeSessionTranscript('p', { messages: [msg('1')] }),
      writeSessionTranscript('q', { messages: [msg('2')] }),
    ]);
    expect((await readSessionTranscript('p')).messages).toEqual([msg('1')]);
    expect((await readSessionTranscript('q')).messages).toEqual([msg('2')]);
  });
});
