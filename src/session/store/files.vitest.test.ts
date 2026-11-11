/** atomicWriteFile's directory kinds: what it may do to the directory it writes into. */
import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFile } from './files.js';

const posix = process.platform !== 'win32';
let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });
const fresh = async (): Promise<string> => (root = await mkdtemp(join(tmpdir(), 'clikcode-files-')));
const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

describe('atomicWriteFile', () => {
  it.runIf(posix)('makes its own directory private, repairing an existing one', async () => {
    const dir = await fresh();
    await chmod(dir, 0o755);
    await atomicWriteFile(join(dir, 'a.json'), '{"b":1}');
    expect(await modeOf(dir)).toBe(0o700);
    expect(await modeOf(join(dir, 'a.json'))).toBe(0o600);
    expect(await readFile(join(dir, 'a.json'), 'utf8')).toBe('{"b":1}');
  });

  it.runIf(posix)('leaves a vendor directory at its mode', async () => {
    const dir = await fresh();
    await chmod(dir, 0o755);
    await atomicWriteFile(join(dir, 'thread.jsonl'), 'x', { directory: 'vendor' });
    expect(await modeOf(dir)).toBe(0o755);
    expect(await modeOf(join(dir, 'thread.jsonl'))).toBe(0o600);
  });

  it.runIf(posix)('keeps a user file\'s exact mode and leaves no temporary behind', async () => {
    const dir = await fresh();
    await chmod(dir, 0o755);
    await atomicWriteFile(join(dir, 'run.sh'), '#!/bin/sh\n', { directory: 'user', durable: false, mode: 0o755 });
    await atomicWriteFile(join(dir, 'notes.md'), 'hi', { directory: 'user', durable: false });
    expect(await modeOf(dir)).toBe(0o755);
    expect(await modeOf(join(dir, 'run.sh'))).toBe(0o755);
    expect((await modeOf(join(dir, 'notes.md'))) & 0o600).toBe(0o600);
    expect((await readdir(dir)).sort()).toEqual(['notes.md', 'run.sh']);
  });
});
