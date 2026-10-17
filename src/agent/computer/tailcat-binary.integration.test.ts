/** Opt-in check of the verified first-use Tailcat installation. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { tailcatBinary } from './tailcat-binary.js';

it.skipIf(!process.env.CLIKCODE_TAILCAT_DOWNLOAD_TEST)('downloads and verifies the official Tailcat binary', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clikcode-tailcat-'));
  try {
    const binary = await tailcatBinary(stateDir);
    expect(binary).toContain(stateDir);
    expect(spawnSync(binary, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe('v0.7.0');
    expect(await tailcatBinary(stateDir)).toBe(binary);
  } finally { await fs.rm(stateDir, { recursive: true, force: true }); }
}, 120_000);
