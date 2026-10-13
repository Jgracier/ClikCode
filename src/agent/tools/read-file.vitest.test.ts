import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileTool } from './read-file.js';
import { disposeSessionState, sessionState } from '../session-state.js';
import type { ToolContext } from '../tool-contract.js';

describe('read_file on a file too large to hold', () => {
  let root: string;
  let dir: string;
  let ctx: ToolContext;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-read-file-'));
    dir = join(root, 'work');
    const state = join(root, 'state');
    await Promise.all([mkdir(dir), mkdir(state)]);
    ctx = {
      cwd: dir, addDirs: [], sessionId: `rf-${Math.random()}`, turnId: 't', stateDir: state, homeDir: root,
      checkpoints: {} as ToolContext['checkpoints'], session: sessionState(state, `rf-${Math.random()}`),
    } as ToolContext;
  });
  afterEach(async () => {
    disposeSessionState(ctx.stateDir, ctx.session.sessionId, 'test over');
    await rm(root, { recursive: true, force: true });
  });

  const big = async (): Promise<void> => {
    // 21 MB of numbered lines, past the 20 MB a file is read whole up to.
    const line = (n: number): string => `row ${n} ${'x'.repeat(20)}\n`;
    const parts: string[] = [];
    for (let n = 1; n <= 700_000; n += 1) parts.push(line(n));
    await writeFile(join(dir, 'big.log'), parts.join(''));
  };

  it('pages through it, as for a smaller file, instead of refusing', async () => {
    await big();
    const first = await readFileTool.run({ path: 'big.log' }, ctx);
    expect(first.isError).toBeFalsy();
    expect(first.output).toMatch(/^1\trow 1 x+\n2\trow 2 /);
    const next = /Continue with offset=(\d+)/.exec(first.output)![1]!;
    const second = await readFileTool.run({ path: 'big.log', offset: Number(next), limit: 3 }, ctx);
    expect(second.output).toContain(`${next}\trow ${next} `);
    expect(second.output).toContain(`Continue with offset=${Number(next) + 3}`);
    const deep = await readFileTool.run({ path: 'big.log', offset: 699_999, limit: 10 }, ctx);
    expect(deep.output).toContain('700000\trow 700000');
    expect(deep.output).toContain('the end of the file');
    const past = await readFileTool.run({ path: 'big.log', offset: 800_000 }, ctx);
    expect(past.isError).toBe(true);
  }, 60_000);

  it('does not show a large binary file', async () => {
    await writeFile(join(dir, 'big.bin'), Buffer.alloc(21 * 1024 * 1024));
    expect((await readFileTool.run({ path: 'big.bin' }, ctx)).output).toMatch(/binary file/);
  }, 60_000);
});
