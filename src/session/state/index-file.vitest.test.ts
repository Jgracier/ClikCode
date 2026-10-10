import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadIndex, resetHarnessStateCaches, storeIndex } from './index-file.js';
import { harnessIndexPath } from './paths.js';
import { readState } from './read.js';
import { writeState } from './write.js';

const previousHome = process.env.CLIKCODE_HOME;
let root: string | undefined;

afterEach(async () => {
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
  resetHarnessStateCaches();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe('storing the index', () => {
  it('leaves the file alone when the bytes it would write are already there', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-index-'));
    process.env.CLIKCODE_HOME = root;
    const state = await readState();
    state.accounts.push({ id: 'a', provider: 'openai', label: 'one', authKind: 'vendor-cli', status: 'ready' } as never);
    await writeState(state);
    const before = await stat(harnessIndexPath());
    // Another process's copy: parsed fresh, so nothing is shared by identity.
    resetHarnessStateCaches();
    const index = await loadIndex();
    await storeIndex(index!, { backup: true });
    const after = await stat(harnessIndexPath());
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});
