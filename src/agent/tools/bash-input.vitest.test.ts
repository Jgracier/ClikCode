import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bashInputTool, bashOutputTool, bashTool, killBashTool } from './bash.js';
import { waitTool } from './wait.js';
import { disposeSessionState, sessionState } from '../session-state.js';
import type { ToolContext } from '../tool-contract.js';

describe.skipIf(process.platform === 'win32')('typing into a background shell', () => {
  let dir: string;
  let ctx: ToolContext;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'clikcode-bash-input-'));
    ctx = {
      cwd: dir, addDirs: [], sessionId: `input-${Math.random()}`, turnId: 't', stateDir: dir, homeDir: dir,
      checkpoints: {} as ToolContext['checkpoints'], session: sessionState(dir, `input-${Math.random()}`),
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

  it('answers a prompt and returns the reply', async () => {
    const id = await background('read -r name; echo "hello $name"; read -r again; echo "bye $again"');
    const first = await bashInputTool.run({ id, text: 'world' }, ctx);
    expect(first.isError).toBeFalsy();
    expect(first.output).toContain('hello world');
    const second = await bashInputTool.run({ id, text: 'now' }, ctx);
    expect(second.output).toContain('bye now');
    expect(second.output).toMatch(new RegExp(`^\\[${id}: exited \\(exit code 0\\)\\]`));
  });

  it('drives a REPL across several inputs', async () => {
    const id = await background('while read -r line; do echo "got:$line"; done');
    expect((await bashInputTool.run({ id, text: 'a' }, ctx)).output).toContain('got:a');
    expect((await bashInputTool.run({ id, text: 'b' }, ctx)).output).toContain('got:b');
    await killBashTool.run({ id }, ctx);
  });

  it('newline false leaves the line open until more arrives', async () => {
    const id = await background('read -r line; echo "line=$line"');
    const partial = await bashInputTool.run({ id, text: 'ab', newline: false, wait_ms: 300 }, ctx);
    expect(partial.output).toContain(`[${id}: running]`);
    expect((await bashInputTool.run({ id, text: 'cd' }, ctx)).output).toContain('line=abcd');
  });

  it('close: true sends end of input', async () => {
    const id = await background('cat; echo done');
    const result = await bashInputTool.run({ id, text: 'last', close: true }, ctx);
    expect(result.output).toContain('last');
    expect(result.output).toContain('done');
    const after = await bashInputTool.run({ id, text: 'more' }, ctx);
    expect(after.isError).toBe(true);
  });

  it('refuses an unknown shell, an empty send, and a shell that has exited', async () => {
    expect((await bashInputTool.run({ id: 'bash_99', text: 'x' }, ctx)).isError).toBe(true);
    const id = await background('sleep 30');
    expect((await bashInputTool.run({ id }, ctx)).output).toMatch(/Nothing to send/);
    await killBashTool.run({ id }, ctx);
    const quick = await background('true');
    await waitTool.run({ shell_ids: [quick], seconds: 10 }, ctx);
    const late = await bashInputTool.run({ id: quick, text: 'x' }, ctx);
    expect(late.isError).toBe(true);
    expect(late.output).toMatch(/not running/);
  });

  it('a shell waiting on stdin still dies to kill_bash, and wait still wakes on its exit', async () => {
    const id = await background('cat');
    await bashInputTool.run({ id, text: 'x', wait_ms: 200 }, ctx);
    expect((await killBashTool.run({ id }, ctx)).output).toBe(`Stopped ${id}.`);
    const reading = await background('read -r x; exit 3');
    setTimeout(() => { void bashInputTool.run({ id: reading, text: 'go', wait_ms: 0 }, ctx); }, 100);
    expect((await waitTool.run({ shell_ids: [reading], seconds: 10 }, ctx)).output).toMatch(new RegExp(`^${reading} exited \\(code 3\\)`));
    expect(ctx.session.notifications.some((note) => note.shellId === reading && note.exitCode === 3)).toBe(true);
    expect((await bashOutputTool.run({ id: reading }, ctx)).output).toContain('exited');
  });
});
