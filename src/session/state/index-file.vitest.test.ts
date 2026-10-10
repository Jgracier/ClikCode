import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { loadIndex, resetHarnessStateCaches, storeIndex, sweepDeadWriterTemps } from './index-file.js';
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

describe('what a killed index writer left', () => {
  it('removes its temp once it is a minute old, and never a live writer\'s', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-index-'));
    const index = join(root, 'index.json');
    const dead = join(root, `index.json.${2 ** 22 + 7}.4e6ca475a9d5.tmp`);
    const live = join(root, `index.json.${process.ppid}.464f8471001c.tmp`);
    const other = join(root, `sessions.json.${2 ** 22 + 7}.464f8471001c.tmp`);
    for (const path of [dead, live, other]) await writeFile(path, '{}');
    expect(await sweepDeadWriterTemps(index), 'just written').toBe(0);
    const old = new Date(Date.now() - 2 * 60_000);
    for (const path of [dead, live, other]) await utimes(path, old, old);
    expect(await sweepDeadWriterTemps(index)).toBe(1);
    expect((await readdir(root)).sort()).toEqual([basename(live), basename(other)].sort());
  });
});
