import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCheckpointStore } from './file-checkpoints.js';

let root: string;
let work: string;
let store: FileCheckpointStore;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gh-ckpt-')));
  work = path.join(root, 'work');
  await fs.mkdir(work, { recursive: true });
  store = new FileCheckpointStore(path.join(root, 'state'));
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

/** One turn that writes `content` to `file`, snapshotted and sealed as the loop does. */
async function turn(turnId: string, file: string, content: string): Promise<void> {
  await store.snapshot('s', turnId, file);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  await store.seal('s', turnId);
}

describe('undo', () => {
  it('restores what the turn changed and removes what it created', async () => {
    const edited = path.join(work, 'a.txt');
    const created = path.join(work, 'new.txt');
    await fs.writeFile(edited, 'before');
    await store.snapshot('s', 't1', edited);
    await store.snapshot('s', 't1', created);
    await fs.writeFile(edited, 'after');
    await fs.writeFile(created, 'x');
    await store.seal('s', 't1');
    const result = await store.undoTurn('s', { roots: [work] });
    expect(result.failed).toEqual([]);
    expect(await fs.readFile(edited, 'utf8')).toBe('before');
    await expect(fs.stat(created)).rejects.toThrow();
  });

  it('refuses to overwrite a file edited after the turn, unless forced', async () => {
    const file = path.join(work, 'a.txt');
    await fs.writeFile(file, 'before');
    await turn('t1', file, 'turn');
    await fs.writeFile(file, 'user edit afterwards');
    const refused = await store.undoTurn('s', { roots: [work] });
    expect(refused.failed[0]?.reason).toMatch(/changed since/);
    expect(await fs.readFile(file, 'utf8')).toBe('user edit afterwards');
    // The turn keeps its snapshots, so the user can still choose to force it.
    const forced = await store.undoTurn('s', { roots: [work], force: true });
    expect(forced.failed).toEqual([]);
    expect(await fs.readFile(file, 'utf8')).toBe('before');
  });

  it('refuses to delete a created file that was changed after the turn', async () => {
    const file = path.join(work, 'new.txt');
    await turn('t1', file, 'made by the turn');
    await fs.writeFile(file, 'kept by the user');
    expect((await store.undoTurn('s')).failed).toHaveLength(1);
    expect(await fs.readFile(file, 'utf8')).toBe('kept by the user');
  });

  it('undoes turns newest first, each checked against the state it left', async () => {
    const file = path.join(work, 'a.txt');
    await fs.writeFile(file, 'v0');
    await turn('20260101T000000000Z-aaaaaaaa', file, 'v1');
    await turn('20260101T000001000Z-bbbbbbbb', file, 'v2');
    const result = await store.undo('s', 2, { roots: [work] });
    expect(result.failed).toEqual([]);
    expect(await fs.readFile(file, 'utf8')).toBe('v0');
  });

  it('refuses a turn that never recorded how it ended', async () => {
    const file = path.join(work, 'a.txt');
    await fs.writeFile(file, 'before');
    await store.snapshot('s', 't1', file);
    await fs.writeFile(file, 'after');
    expect((await store.undoTurn('s')).failed[0]?.reason).toMatch(/did not finish/);
    expect(await fs.readFile(file, 'utf8')).toBe('after');
  });

  it('resolves symlinks when restoring, not from the recorded text', async () => {
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    const file = path.join(work, 'dir', 'a.txt');
    await turn('t1', file, 'turn');
    // The directory is swapped for a link out of the workspace after the turn.
    await fs.rm(path.join(work, 'dir'), { recursive: true });
    await fs.symlink(outside, path.join(work, 'dir'));
    await fs.writeFile(path.join(outside, 'a.txt'), 'turn');
    const result = await store.undoTurn('s', { roots: [work], force: true });
    expect(result.failed[0]?.reason).toMatch(/outside the allowed roots/);
    expect(await fs.readFile(path.join(outside, 'a.txt'), 'utf8')).toBe('turn');
  });
});
