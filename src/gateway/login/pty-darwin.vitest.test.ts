/** macOS's `script` stops ("script: tcgetattr/ioctl: Operation not supported
 * on socket") unless its input answers tcgetattr with ENOTTY: a pipe(2) pipe
 * passes; Node's socketpair stdin and a FIFO (built on sockets there) do not.
 * Measured on a MacBook (macOS 15.7), 2026-10-22. runInPty gives it a pipe(2)
 * there. Run here with a stand-in `script` that refuses the same inputs. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ptyCommand, runInPty } from './pty.js';

let dir: string;
let savedPath: string | undefined;
let savedTmp: string | undefined;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-pty-darwin-'));
  writeFileSync(join(dir, 'script'), [
    '#!/bin/sh',
    // What fd 0 is: pipe:[n] for pipe(2), socket:[n] for a socketpair, a path for a FIFO.
    'case "$(readlink /proc/$$/fd/0)" in pipe:*) ;; *) echo "script: tcgetattr/ioctl: Operation not supported on socket" >&2; exit 1;; esac',
    'IFS= read -r line',
    'echo "got:$line"',
    'exit 7',
  ].join('\n'));
  chmodSync(join(dir, 'script'), 0o755);
  savedPath = process.env.PATH;
  savedTmp = process.env.TMPDIR;
  process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.TMPDIR = dir;
});
afterAll(() => { process.env.PATH = savedPath; process.env.TMPDIR = savedTmp; rmSync(dir, { recursive: true, force: true }); });

const leftover = (): string[] => readdirSync(dir).filter((name) => name.startsWith('clikcode-pty.'));

describe.skipIf(!existsSync('/proc/self/fd/0'))('a sign-in down a pty on macOS', () => {
  it('runs script on a real pipe, carries what is typed, keeps its exit status, and leaves nothing behind', async () => {
    let out = '';
    const result = await runInPty({
      binary: 'claude', args: ['auth', 'login'], env: {}, platform: 'darwin',
      onOutput: (chunk) => { out += chunk; },
      onStdin: (write) => { setTimeout(() => write('the code\n'), 100); },
    });
    expect(out).not.toMatch(/not supported on socket|Terminated|Broken pipe/);
    expect(out).toContain('got:the code');
    expect(result).toEqual({ teed: true, exitCode: 7 });
    expect(leftover()).toEqual([]);
  }, 20_000);

  it('stops it all when told to: script and the dd feeding it', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const result = runInPty({
      binary: 'claude', args: ['auth', 'login'], env: {}, platform: 'darwin',
      onOutput: () => undefined, onStdin: () => undefined, signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 300);
    expect((await result).teed).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it('is script itself elsewhere, and nothing on Windows', () => {
    expect(ptyCommand('claude', ['login'], 'linux')?.file).toBe('script');
    const mac = ptyCommand('claude', ['login'], 'darwin')!;
    expect(mac.file).toBe('/bin/sh');
    expect(mac.argv.slice(0, 6)).toEqual(['-c', expect.stringContaining('exec dd'), 'sh', '-q', '/dev/null', '/bin/sh']);
    expect(mac.argv.slice(-2)).toEqual(['claude', 'login']);
    expect(ptyCommand('claude', ['login'], 'win32')).toBeUndefined();
  });
});
