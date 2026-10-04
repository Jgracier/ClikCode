import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bashTool, killBashTool } from './bash.js';
import { waitTool } from './wait.js';
import { disposeSessionState, sessionState } from '../session-state.js';
import type { ToolContext } from '../tool-contract.js';

describe.skipIf(process.platform === 'win32')('the wait tool', () => {
  let dir: string;
  let ctx: ToolContext;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'clikcode-wait-'));
    ctx = {
      cwd: dir, addDirs: [], sessionId: `wait-${Math.random()}`, turnId: 't', stateDir: dir, homeDir: dir,
      checkpoints: {} as ToolContext['checkpoints'], session: sessionState(dir, `wait-${Math.random()}`),
    } as ToolContext;
  });
  afterEach(async () => {
    disposeSessionState(dir, ctx.session.sessionId, 'test over');
    await rm(dir, { recursive: true, force: true });
  });

  const background = async (command: string): Promise<string> => {
    const started = await bashTool.run({ command, run_in_background: true }, ctx);
    return /background shell (bash_\d+)/.exec(started.output)![1]!;
  };

  it('wakes the moment a background shell exits, not when the time is up', async () => {
    const id = await background('sleep 0.3; exit 4');
    const begun = Date.now();
    const result = await waitTool.run({ shell_ids: [id], seconds: 60 }, ctx);
    expect(result.output).toMatch(new RegExp(`^${id} exited \\(code 4\\)`));
    expect(Date.now() - begun).toBeLessThan(5_000);
  });

  it('with nothing named, wakes on any running background shell', async () => {
    await background('sleep 30');
    const quick = await background('sleep 0.2');
    expect((await waitTool.run({ seconds: 60 }, ctx)).output).toMatch(new RegExp(`^${quick} exited`));
  });

  it('wakes when a file appears', async () => {
    const target = join(dir, 'ready.flag');
    setTimeout(() => { void writeFile(target, 'ok'); }, 200);
    const begun = Date.now();
    expect((await waitTool.run({ path: 'ready.flag', seconds: 60 }, ctx)).output).toMatch(/^ready\.flag changed/);
    expect(Date.now() - begun).toBeLessThan(5_000);
  });

  it('wakes when the time is up, if nothing happens sooner', async () => {
    const id = await background('sleep 30');
    expect((await waitTool.run({ shell_ids: [id], seconds: 1 }, ctx)).output).toMatch(/^Waited 1s; nothing happened sooner/);
    await killBashTool.run({ id }, ctx);
  });

  it('stops when the turn is cancelled', async () => {
    const controller = new AbortController();
    const id = await background('sleep 30');
    setTimeout(() => controller.abort(), 100);
    await expect(waitTool.run({ shell_ids: [id], seconds: 60 }, { ...ctx, signal: controller.signal })).rejects.toThrow();
  });

  it('says so for a shell it does not know, or one already done', async () => {
    expect((await waitTool.run({ shell_ids: ['bash_99'] }, ctx)).isError).toBe(true);
    const id = await background('true');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await waitTool.run({ shell_ids: [id] }, ctx)).output).toMatch(/has already exited/);
  });
});
