/** A message typed while a long call runs makes the call return, never die:
 * the model hears the steer in seconds and what was running carries on. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bashTool, killBashTool } from './bash.js';
import { waitTool } from './wait.js';
import { disposeSessionState, sessionState } from '../session-state.js';
import type { ToolContext } from '../tool-contract.js';

describe.skipIf(process.platform === 'win32')('steer while a long call runs', () => {
  let dir: string;
  let ctx: ToolContext;
  let steer: AbortController;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'clikcode-steer-'));
    steer = new AbortController();
    ctx = {
      cwd: dir, addDirs: [], sessionId: `steer-${Math.random()}`, turnId: 't', stateDir: dir, homeDir: dir,
      checkpoints: { record: async () => undefined } as unknown as ToolContext['checkpoints'], session: sessionState(dir, `steer-${Math.random()}`),
      steerSignal: steer.signal,
    } as ToolContext;
  });
  afterEach(async () => {
    for (const shell of ctx.session.shells.values()) if (shell.status === 'running') await killBashTool.run({ id: shell.id }, ctx).catch(() => undefined);
    disposeSessionState(dir, ctx.session.sessionId, 'test over');
    await rm(dir, { recursive: true, force: true });
  });

  it('wait returns at once, and says nothing was stopped', async () => {
    await bashTool.run({ command: 'sleep 30', run_in_background: true }, ctx);
    const begun = Date.now();
    const waiting = waitTool.run({ seconds: 600 }, ctx);
    setTimeout(() => steer.abort(), 100);
    const result = await waiting;
    expect(result.output).toMatch(/user sent a message/);
    expect(Date.now() - begun).toBeLessThan(5_000);
  });

  it('a foreground shell command returns early and keeps running as a background shell', async () => {
    const begun = Date.now();
    const running = bashTool.run({ command: 'echo started; sleep 30', timeout_ms: 600_000 }, ctx);
    setTimeout(() => steer.abort(), 300);
    const result = await running;
    expect(Date.now() - begun).toBeLessThan(10_000);
    expect(result.output).toContain('started');
    expect(result.output).toMatch(/NOT stopped.*background shell (bash_\d+)/s);
    const id = /background shell (bash_\d+)/.exec(result.output)![1]!;
    expect(ctx.session.shells.get(id)?.status).toBe('running');
  });
});
