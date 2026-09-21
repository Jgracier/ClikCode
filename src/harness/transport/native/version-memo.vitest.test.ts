import { chmod, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  binaryFingerprint, rememberVersion, rememberedVersion, resetVersionMemo, saveVersionMemo,
} from './version-memo.js';
import { resolveBinaryPath } from './binary.js';

/**
 * Inspecting the catalog spawns every installed harness -- 1,359 ms for 24 of
 * them here. The answer is a fact about a FILE, so it is keyed on the file
 * rather than on a clock: same path, mtime and size means the same version,
 * however long ago it was learned.
 */
describe('the version memo', () => {
  let home: string;
  let binary: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'clikcode-version-'));
    process.env.CLIKCODE_HOME = home;
    resetVersionMemo();
    binary = join(home, 'fakecli');
    await writeFile(binary, '#!/bin/sh\necho 1.0.0\n');
    await chmod(binary, 0o755);
  });

  afterEach(async () => {
    delete process.env.CLIKCODE_HOME;
    resetVersionMemo();
    await rm(home, { recursive: true, force: true });
  });

  it('remembers a version against the file it describes', async () => {
    const print = await binaryFingerprint(binary);
    await rememberVersion('fake', print!, { version: '1.0.0' });
    expect((await rememberedVersion('fake', print))?.version).toBe('1.0.0');
  });

  it('forgets when the binary is replaced, however recently it was learned', async () => {
    // An upgrade is exactly this: same path, new mtime. A TTL would serve the
    // old version for the rest of its window.
    const print = await binaryFingerprint(binary);
    await rememberVersion('fake', print!, { version: '1.0.0' });
    const later = new Date(Date.now() + 60_000);
    await utimes(binary, later, later);
    expect(await rememberedVersion('fake', await binaryFingerprint(binary))).toBeUndefined();
  });

  it('forgets when the size changes even if the mtime did not', async () => {
    const print = await binaryFingerprint(binary);
    await rememberVersion('fake', print!, { version: '1.0.0' });
    await writeFile(binary, '#!/bin/sh\necho 2.0.0 with more bytes\n');
    await utimes(binary, new Date(print!.mtimeMs), new Date(print!.mtimeMs));
    expect(await rememberedVersion('fake', await binaryFingerprint(binary))).toBeUndefined();
  });

  it('forgets when a different file on PATH wins the name', async () => {
    const print = await binaryFingerprint(binary);
    await rememberVersion('fake', print!, { version: '1.0.0' });
    const other = join(home, 'other-fakecli');
    await writeFile(other, '#!/bin/sh\necho 9.9.9\n');
    await chmod(other, 0o755);
    expect(await rememberedVersion('fake', await binaryFingerprint(other))).toBeUndefined();
  });

  it('says nothing about a binary that is gone', async () => {
    const print = await binaryFingerprint(binary);
    await rememberVersion('fake', print!, { version: '1.0.0' });
    await rm(binary);
    expect(await binaryFingerprint(binary)).toBeUndefined();
    expect(await rememberedVersion('fake', await binaryFingerprint(binary))).toBeUndefined();
  });

  it('survives a restart, which is the whole point', async () => {
    const print = await binaryFingerprint(binary);
    await rememberVersion('fake', print!, { version: '1.0.0' });
    await saveVersionMemo();
    resetVersionMemo();
    expect((await rememberedVersion('fake', await binaryFingerprint(binary)))?.version).toBe('1.0.0');
  });

  it('resolves a binary to a real path, which is what gets fingerprinted', async () => {
    expect(await resolveBinaryPath('fakecli', { path: home })).toBe(binary);
    expect(await resolveBinaryPath('nope', { path: home })).toBeUndefined();
  });
});
