import { describe, expect, it } from 'vitest';
import { runCli } from './run-cli.js';

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe.skipIf(process.platform === 'win32')('runCli', () => {
  it('answers when the command exits even if a grandchild still holds its output', async () => {
    const started = Date.now();
    const result = await runCli('sh', ['-c', 'sleep 30 & echo hi'], { timeoutMs: 20_000 });
    expect(result.code).toBe(0);
    expect(result.text).toContain('hi');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('runs nothing for a signal that is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    const result = await runCli('sh', ['-c', 'sleep 5; echo ran'], { signal: controller.signal });
    expect(result).toEqual({ code: null, text: '', missing: false });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('stops the whole process group, and SIGKILLs a command that ignores SIGTERM', async () => {
    const controller = new AbortController();
    const running = runCli('sh', ['-c', "trap '' TERM; sleep 30 & echo $!; wait"], { signal: controller.signal, graceMs: 300 });
    await new Promise(resolve => setTimeout(resolve, 300));
    controller.abort();
    const started = Date.now();
    const result = await running;
    expect(result.code).toBeNull();
    expect(Date.now() - started).toBeLessThan(4_000);
    const grandchild = Number(result.text.trim());
    expect(grandchild).toBeGreaterThan(0);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(alive(grandchild)).toBe(false);
  });

  it('stops on the timeout', async () => {
    const result = await runCli('sh', ['-c', 'sleep 30'], { timeoutMs: 200, graceMs: 200 });
    expect(result.code).toBeNull();
  });
});
