import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { listStoredSessionIds, resetSessionStoreCache, storeSessionFile } from './records.js';
import { sessionsDirectory } from './paths.js';

const previousHome = process.env.CLIKCODE_HOME;
let root: string | undefined;

afterEach(async () => {
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  resetSessionStoreCache();
});

describe('listStoredSessionIds', () => {
  it('recovers a filename-safe id from the filename alone, even from a file whose content is garbage', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-records-'));
    process.env.CLIKCODE_HOME = root;
    await mkdir(sessionsDirectory(), { recursive: true });
    // Not valid JSON at all: if this were opened and parsed, the id would be
    // dropped entirely (the catch clause), not merely wrong.
    await writeFile(join(sessionsDirectory(), 'plain-id-1.json'), 'not json{{{');
    expect(await listStoredSessionIds()).toEqual(['plain-id-1']);
  });

  it('still reads the file for a digest-shaped stem, correctness over the shortcut', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-records-'));
    process.env.CLIKCODE_HOME = root;
    await mkdir(sessionsDirectory(), { recursive: true });
    const unsafeId = 'weird id/with:chars';
    const digest = `h-${createHash('sha256').update(unsafeId).digest('hex')}`;
    await writeFile(join(sessionsDirectory(), `${digest}.json`), JSON.stringify({ v: 1, id: unsafeId }));
    expect(await listStoredSessionIds()).toEqual([unsafeId]);
  });

  it('still reads a stem that merely looks digest-shaped, rather than trusting the coincidence', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-records-'));
    process.env.CLIKCODE_HOME = root;
    await mkdir(sessionsDirectory(), { recursive: true });
    const lookalike = `h-${'a'.repeat(64)}`;
    // The file's own id disagrees with the filename -- proof this path truly
    // read the file rather than assuming the stem.
    await writeFile(join(sessionsDirectory(), `${lookalike}.json`), JSON.stringify({ v: 1, id: 'actual-id' }));
    expect(await listStoredSessionIds()).toEqual(['actual-id']);
  });

  it('agrees with storeSessionFile/loadSessionFile round-tripping a mix of ids', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-records-'));
    process.env.CLIKCODE_HOME = root;
    await storeSessionFile('session-a', { v: 1, id: 'session-a', messages: [{ role: 'user', content: 'hi' }] });
    await storeSessionFile('weird/id here', { v: 1, id: 'weird/id here', messages: [{ role: 'user', content: 'hi' }] });
    resetSessionStoreCache();
    expect(new Set(await listStoredSessionIds())).toEqual(new Set(['session-a', 'weird/id here']));
  });
});
