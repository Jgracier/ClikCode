import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../tool-contract.js';

let root: string;
const BIG = 6 * 1024 * 1024;

const context = (): ToolContext => ({ cwd: root, addDirs: [], stateDir: path.join(root, '.state'), homeDir: path.join(root, 'home') } as unknown as ToolContext);

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'grep-')));
  // A log bigger than 5 MB with the one line that matters at the end, and a small file beside it.
  await fs.writeFile(path.join(root, 'big.log'), `${'padding line of no interest\n'.repeat(Math.ceil(BIG / 28))}NEEDLE-in-the-big-log\n`);
  await fs.writeFile(path.join(root, 'small.txt'), 'nothing here\n');
});
afterEach(async () => { vi.resetModules(); vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });

describe('grep on a file larger than 5 MB', () => {
  it('finds a match in it with ripgrep, rather than skipping the file', async () => {
    const { grepTool } = await import('./grep.js');
    const result = await grepTool.run({ pattern: 'NEEDLE' }, context());
    expect(result.output).toMatch(/big\.log:\d+:NEEDLE-in-the-big-log/);
  });

  it('without ripgrep, says which file was not searched instead of answering as if it had been', async () => {
    vi.stubEnv('PATH', '/nonexistent');
    vi.resetModules();
    const { grepTool } = await import('./grep.js');
    const result = await grepTool.run({ pattern: 'NEEDLE' }, context());
    expect(result.output).not.toBe('No matches.');
    expect(result.output).toMatch(/1 file over 5 MB not searched.*big\.log/);
  });
});
