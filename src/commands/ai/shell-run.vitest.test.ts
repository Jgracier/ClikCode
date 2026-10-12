import { describe, expect, it } from 'vitest';
import { runShellCommand, SHELL_OUTPUT_MAX_BYTES } from './shell-run.js';

describe('runShellCommand', () => {
  it('returns a short output whole', async () => {
    const result = await runShellCommand('printf "one\\ntwo\\n"', process.cwd());
    expect(result).toMatchObject({ output: 'one\ntwo', exitCode: 0, timedOut: false });
  });

  it('keeps the END of a long output -- the failing line is the part that matters -- and says what was left out', async () => {
    const result = await runShellCommand('echo FIRST-LINE; seq 1 20000; echo THE-LAST-LINE-ERROR >&2; exit 3', process.cwd());
    expect(result.exitCode).toBe(3);
    expect(result.output).toContain('FIRST-LINE');
    expect(result.output).toContain('THE-LAST-LINE-ERROR');
    expect(result.output).toContain('20000');
    expect(result.output).toMatch(/\[\d+ characters of output omitted from the middle/);
    expect(result.output.length).toBeLessThan(SHELL_OUTPUT_MAX_BYTES + 400);
    expect(result.output).not.toMatch(/scrollback/);
  });

  it('has no clock of its own: a command the user started runs until it ends', async () => {
    const result = await runShellCommand('sleep 0.4; echo finished', process.cwd());
    expect(result).toMatchObject({ output: 'finished', exitCode: 0, timedOut: false });
  });

  it('stops at a bound only when the caller sets one (a headless call has no Esc)', async () => {
    const result = await runShellCommand('sleep 30', process.cwd(), undefined, { timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
  });

  it('stops when the caller cancels', async () => {
    const controller = new AbortController();
    const run = runShellCommand('sleep 30', process.cwd(), controller.signal);
    setTimeout(() => controller.abort(), 100);
    const result = await run;
    expect(result.timedOut).toBe(false);
    expect(result.exitCode === null || result.exitCode !== 0).toBe(true);
  });
});
