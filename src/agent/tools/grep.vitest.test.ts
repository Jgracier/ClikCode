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

describe('how much a broad search returns', () => {
  const searches = [['with ripgrep', undefined], ['without ripgrep', '/nonexistent']] as const;
  for (const [name, noPath] of searches) {
    describe(name, () => {
      const grep = async () => {
        if (noPath) vi.stubEnv('PATH', noPath);
        vi.resetModules();
        return (await import('./grep.js')).grepTool;
      };
      beforeEach(async () => {
        await fs.writeFile(path.join(root, 'many.txt'), `${Array.from({ length: 150 }, (_, index) => `match number ${index}`).join('\n')}\n`);
        await fs.writeFile(path.join(root, 'minified.js'), `match ${'x'.repeat(2000)}\n`);
        for (let index = 0; index < 120; index += 1) await fs.writeFile(path.join(root, `file-${index}.md`), 'listed\n');
      });

      it('shows 80 matching lines and says how to see the rest', async () => {
        const result = await (await grep()).run({ pattern: 'match number', glob: 'many.txt' }, context());
        expect(result.output.split('\n').filter((line) => line.includes('match number'))).toHaveLength(80);
        expect(result.output).toContain('70 more lines; narrow the search or raise head_limit.');
        const all = await (await grep()).run({ pattern: 'match number', glob: 'many.txt', head_limit: 200 }, context());
        expect(all.output.split('\n').filter((line) => line.includes('match number'))).toHaveLength(150);
      });

      it('cuts a very long matching line and says how much it left out', async () => {
        const result = await (await grep()).run({ pattern: '^match x', glob: 'minified.js' }, context());
        expect(result.output).toMatch(/\[\d+ more characters\]/);
        expect(result.output.length).toBeLessThan(500);
      });

      it('still lists up to 200 files and counts', async () => {
        const result = await (await grep()).run({ pattern: 'listed', output_mode: 'files', glob: '*.md' }, context());
        expect(result.output.split('\n').filter((line) => line.endsWith('.md'))).toHaveLength(120);
      });
    });
  }
});
