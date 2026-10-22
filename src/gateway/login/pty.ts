/**
 * Running a vendor's sign-in down a pty in the background, so ClikCode can
 * read its screen and answer it (vendor-sign-in.ts) while nobody sees it.
 *
 * Piping the vendor's stdio is not enough: confirmed live, several check
 * that BOTH stdin and stdout are real TTYs before they print anything
 * (Antigravity, every Ink app). `script(1)` gives the child a pty -- every
 * TTY check passes and its TUI draws normally -- and echoes everything to
 * its own stdout, which is read here, while its own stdin (a pipe) carries
 * what ClikCode types. No dependency; it ships with util-linux and macOS.
 *
 * The typescript file is always /dev/null: the live stream is the point, and
 * BSD script does not flush that file until exit anyway.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, openSync, rmSync, write } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnPortable as spawn, terminatePortable } from '../../harness/transport/spawn.js';

/** Single-quote for `sh -c`, the only form util-linux script accepts. */
export function shellQuote(parts: readonly string[]): string {
  return parts.map((part) => `'${part.replace(/'/g, `'\\''`)}'`).join(' ');
}

/** The size of the pty a sign-in runs in. script(1) takes its pty's size
 * from its own input, which here is a pipe: 0x0, and an Ink app (Gemini's)
 * then draws its banner and nothing else, ever. */
export const SIGN_IN_ROWS = 40;
export const SIGN_IN_COLUMNS = 100;
const SIZED = `stty rows ${SIGN_IN_ROWS} cols ${SIGN_IN_COLUMNS} 2>/dev/null; exec`;

/** How to ask this platform's `script` to run a command down a pty of a
 * real size, or undefined where there is no such thing (Windows). The two
 * implementations take their command in genuinely different ways:
 * util-linux wants one shell string after `-c`, BSD wants the argv after the
 * file. */
export function scriptArgv(
  binary: string, args: readonly string[], platform: NodeJS.Platform = process.platform,
): readonly string[] | undefined {
  if (platform === 'win32') return undefined;
  if (platform === 'darwin') return ['-q', '/dev/null', '/bin/sh', '-c', `${SIZED} "$0" "$@"`, binary, ...args];
  // -f flushes after every write; without it the parent sees the URL only
  // once the child has already exited, which is far too late to be useful.
  // -e returns the CHILD's exit status: without it util-linux script always
  // exits 0, so a failed sign-in reported success. Verified both ways here,
  // and that BSD script already does this by default (hence no -e above).
  return ['-q', '-e', '-f', '-c', `${SIZED} ${shellQuote([binary, ...args])}`, '/dev/null'];
}

/** What to spawn for a command down a pty, or undefined where there is no
 * `script` (Windows). */
export function ptyCommand(
  binary: string, args: readonly string[], platform: NodeJS.Platform = process.platform,
): { file: string; argv: readonly string[] } | undefined {
  const argv = scriptArgv(binary, args, platform);
  return argv ? { file: 'script', argv } : undefined;
}

/** macOS: `script` refuses an input that is a socket -- tcgetattr on it is
 * EOPNOTSUPP, not the ENOTTY it accepts, and it exits 1 with "script:
 * tcgetattr/ioctl: Operation not supported on socket" -- and Node's child
 * stdio pipes are sockets (libuv's socketpair). Seen live: every Claude Code
 * sign-in a chat on a Mac started failed in 15 ms. So there its input is a
 * real pipe: a FIFO this process opens read-write (so the open never blocks),
 * unlinks at once (the open ends keep it), hands to `script` as its stdin,
 * and writes what ClikCode types into. util-linux script takes a socket, so
 * elsewhere it is Node's own pipe. */
function realPipe(): { fd: number; write(text: string): void; close(): void } {
  const path = join(tmpdir(), `clikcode-pty-${process.pid}-${randomBytes(6).toString('hex')}`);
  execFileSync('mkfifo', ['-m', '600', path]);
  let fd: number;
  try { fd = openSync(path, constants.O_RDWR); } finally { rmSync(path, { force: true }); }
  let open = true;
  return {
    fd,
    write: (text) => { if (open) write(fd, text, () => { /* fail-open-ok: the vendor already exited */ }); },
    close: () => { if (open) { open = false; closeSync(fd); } },
  };
}

interface PtyResult {
  /** False when this platform has no `script` (Windows); the caller runs the
   * vendor on plain pipes instead. */
  teed: boolean;
  exitCode: number | null;
}

/** Run a command down a pty of a real size: its output to `onOutput`, what
 * ClikCode types through `onStdin`'s writer. Resolves when it exits,
 * whatever its status -- what a failure means is the caller's to say. */
export async function runInPty(input: {
  binary: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  onOutput: (chunk: string) => void;
  onStdin: (write: (text: string) => void) => void;
  /** Ends it (SIGTERM to script, which hangs up the vendor). */
  signal?: AbortSignal;
  platform?: NodeJS.Platform;
}): Promise<PtyResult> {
  const command = ptyCommand(input.binary, input.args, input.platform);
  if (!command) return { teed: false, exitCode: null };
  const pipe = (input.platform ?? process.platform) === 'darwin' ? realPipe() : undefined;
  return new Promise<PtyResult>((resolve, reject) => {
    const child = spawn(command.file, [...command.argv], {
      stdio: [pipe?.fd ?? 'pipe', 'pipe', 'pipe'],
      // A terminal of a known kind: under ClikCode's own TERM=dumb (a
      // script, a test) some vendors draw differently, or not at all.
      env: { ...process.env, ...(!process.env.TERM || process.env.TERM === 'dumb' ? { TERM: 'xterm-256color' } : {}), ...input.env },
    });
    // Writing after the vendor has gone is not an error: it finished (a
    // browser callback, say) before the user answered.
    child.stdin?.on('error', () => { /* fail-open-ok: vendor already exited */ });
    input.onStdin((text: string) => { if (pipe) pipe.write(text); else child.stdin?.write(text); });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    const read = (chunk: string): void => {
      try { input.onOutput(chunk); } catch { /* fail-open-ok: reading must never break the sign-in */ }
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    // A ClikCode told to stop takes the vendor with it, rather than leaving
    // a login waiting on a browser nobody will open.
    const stop = (): void => { terminatePortable(child, 'SIGTERM'); };
    input.signal?.addEventListener('abort', stop, { once: true });
    process.once('SIGTERM', stop);
    if (process.platform !== 'win32') process.once('SIGHUP', stop);
    const cleanup = (): void => {
      pipe?.close();
      input.signal?.removeEventListener('abort', stop);
      process.off('SIGTERM', stop);
      if (process.platform !== 'win32') process.off('SIGHUP', stop);
    };
    // ENOENT means no script(1) on this machine: not an error, just a
    // platform without the capability, same as Windows.
    child.on('error', (error: NodeJS.ErrnoException) => {
      cleanup();
      if (error.code === 'ENOENT') resolve({ teed: false, exitCode: null });
      else reject(error);
    });
    child.on('close', (code) => { cleanup(); resolve({ teed: true, exitCode: code }); });
  });
}
