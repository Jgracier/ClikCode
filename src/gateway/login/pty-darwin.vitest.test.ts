/** macOS's `script` refuses an input that is a socket ("tcgetattr/ioctl:
 * Operation not supported on socket"), and Node's child stdin is one, so
 * there runInPty gives it a FIFO instead. Run here with a stand-in
 * `script` that, like macOS's, exits 1 unless its input is a pipe or a tty. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ptyCommand, runInPty } from './pty.js';

let dir: string;
let savedPath: string | undefined;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-pty-darwin-'));
  writeFileSync(join(dir, 'script'), [
    '#!/bin/sh',
    '[ -p /dev/stdin ] || [ -t 0 ] || { echo "script: tcgetattr/ioctl: Operation not supported on socket" >&2; exit 1; }',
    'IFS= read -r line',
    'echo "got:$line"',
    'exit 7',
  ].join('\n'));
  chmodSync(join(dir, 'script'), 0o755);
  savedPath = process.env.PATH;
  process.env.PATH = `${dir}:${process.env.PATH}`;
});
afterAll(() => { process.env.PATH = savedPath; rmSync(dir, { recursive: true, force: true }); });

describe('a sign-in down a pty on macOS', () => {
  it('gives script a real pipe for input, carries what is typed, and keeps its exit status', async () => {
    let out = '';
    const result = await runInPty({
      binary: 'claude', args: ['auth', 'login'], env: {}, platform: 'darwin',
      onOutput: (chunk) => { out += chunk; },
      onStdin: (write) => { setTimeout(() => write('the code\n'), 100); },
    });
    expect(out).not.toMatch(/not supported on socket/);
    expect(out).toContain('got:the code');
    expect(result).toEqual({ teed: true, exitCode: 7 });
  }, 30_000);

  it('is script on Linux and macOS, and nothing on Windows', () => {
    expect(ptyCommand('claude', ['login'], 'linux')?.file).toBe('script');
    expect(ptyCommand('claude', ['login'], 'darwin')?.file).toBe('script');
    expect(ptyCommand('claude', ['login'], 'win32')).toBeUndefined();
  });

  it('a stop reaches script', async () => {
    writeFileSync(join(dir, 'script'), '#!/bin/sh\nexec sleep 30\n');
    const controller = new AbortController();
    const running = runInPty({ binary: 'claude', args: [], env: {}, platform: 'darwin', onOutput: () => undefined, onStdin: () => undefined, signal: controller.signal });
    setTimeout(() => controller.abort(), 300);
    const started = Date.now();
    await running;
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);
});
