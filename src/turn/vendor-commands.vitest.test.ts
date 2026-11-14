import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { knownVendorCommands, rememberVendorCommands } from './vendor-commands.js';

const previous = process.env.CLIKCODE_HOME;
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'vendor-commands-')); process.env.CLIKCODE_HOME = root; });
afterEach(async () => {
  if (previous === undefined) delete process.env.CLIKCODE_HOME; else process.env.CLIKCODE_HOME = previous;
  await rm(root, { recursive: true, force: true });
});

describe('the commands each harness says it has', () => {
  it('are kept per harness by the process that heard them, for any window to read', async () => {
    expect(knownVendorCommands('claude')).toEqual([]);
    await rememberVendorCommands('claude', [{ name: 'security-review', description: 'Review for security' }]);
    await rememberVendorCommands('codex', [{ name: 'compact' }]);
    expect(knownVendorCommands('claude')).toEqual([{ name: 'security-review', description: 'Review for security' }]);
    expect(knownVendorCommands('codex')).toEqual([{ name: 'compact' }]);
    expect(knownVendorCommands(undefined)).toEqual([]);
  });

  it('keeps the newest list, and an empty answer does not wipe it', async () => {
    await rememberVendorCommands('vibe', [{ name: 'a' }]);
    await rememberVendorCommands('vibe', [{ name: 'b' }]);
    await rememberVendorCommands('vibe', []);
    expect(knownVendorCommands('vibe')).toEqual([{ name: 'b' }]);
    expect(JSON.parse(await readFile(join(root, 'cache', 'vendor-commands.json'), 'utf8')).harnesses.vibe.commands).toEqual([{ name: 'b' }]);
  });
});
