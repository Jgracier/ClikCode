/**
 * Running a vendor login so ClikCode can read what it prints.
 *
 * Every vendor CLI owns the terminal for its own sign-in (`stdio: 'inherit'`),
 * which is why ClikCode has never seen a word of it. Piping stdout instead is
 * not an option: confirmed live, Antigravity checks that BOTH stdin and stdout
 * are real TTYs before it will start its OAuth prompt at all, and piping
 * stdout alone made it fail in under a second.
 *
 * `script(1)` resolves that: it allocates a pty for the child -- so every TTY
 * check still passes and the vendor's own TUI renders normally -- while
 * echoing everything to its own stdout, which ClikCode can read and forward.
 * No dependency; it ships with util-linux and with macOS.
 *
 * Verified on both platforms before this was written: the child reports
 * `[ -t 0 ] && [ -t 1 ]`, a printed URL is visible to the parent within
 * ~10ms (Linux) / ~484ms (macOS) while the child is still waiting for input,
 * and the pty inherits the real terminal's size (checked at 70x32, the phone
 * keyboard-up size, which came through as 70x32 rather than a default 80x24).
 *
 * The typescript file is always /dev/null: the live stream is the point, and
 * BSD script does not flush that file until exit anyway.
 */
import { spawnPortable as spawn, terminatePortable } from './spawn-portable.js';

/** Single-quote for `sh -c`, the only form util-linux script accepts. */
export function shellQuote(parts: readonly string[]): string {
  return parts.map((part) => `'${part.replace(/'/g, `'\\''`)}'`).join(' ');
}

/** How to ask this platform's `script` to run a command down a pty, or
 * undefined where there is no such thing (Windows). The two implementations
 * take their command in genuinely different ways: util-linux wants one shell
 * string after `-c`, BSD wants the argv after the file. */
export function scriptArgv(
  binary: string, args: readonly string[], platform: NodeJS.Platform = process.platform,
): readonly string[] | undefined {
  if (platform === 'win32') return undefined;
  if (platform === 'darwin') return ['-q', '/dev/null', binary, ...args];
  // -f flushes after every write; without it the parent sees the URL only
  // once the child has already exited, which is far too late to be useful.
  return ['-q', '-f', '-c', shellQuote([binary, ...args]), '/dev/null'];
}

export interface TeedLoginResult {
  /** False when this platform has no `script`; the caller must fall back to
   * handing the terminal over directly, unwatched. */
  teed: boolean;
  exitCode: number | null;
}

/** Run a command down a pty, forwarding its output to the real terminal and
 * to `onOutput`. Resolves when the command exits, whatever its status --
 * interpreting a failed login is the caller's job. */
export async function runTeedLogin(input: {
  binary: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  onOutput: (chunk: string) => void;
  write?: (chunk: string) => void;
  platform?: NodeJS.Platform;
}): Promise<TeedLoginResult> {
  const argv = scriptArgv(input.binary, input.args, input.platform);
  if (!argv) return { teed: false, exitCode: null };
  const write = input.write ?? ((chunk: string) => { process.stdout.write(chunk); });
  return new Promise<TeedLoginResult>((resolve, reject) => {
    const child = spawn('script', [...argv], {
      stdio: ['inherit', 'pipe', 'inherit'],
      env: { ...process.env, ...input.env },
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      // The user sees the vendor's own output, unaltered and in real time.
      write(chunk);
      try { input.onOutput(chunk); } catch { /* fail-open-ok: watching must never break the login */ }
    });
    // Parity with the direct hand-over path: a signal sent to ClikCode must
    // reach the login, or a killed ClikCode leaves a vendor CLI holding the
    // terminal. Ctrl-C needs nothing here -- script puts the real terminal in
    // raw mode and forwards the byte to the pty, where the child's own line
    // discipline raises SIGINT.
    const forward = (signal: NodeJS.Signals) => () => { terminatePortable(child, signal); };
    const onInterrupt = forward('SIGINT');
    const onTerminate = forward('SIGTERM');
    const onHangup = forward('SIGHUP');
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    if (process.platform !== 'win32') process.once('SIGHUP', onHangup);
    const cleanup = (): void => {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
      if (process.platform !== 'win32') process.off('SIGHUP', onHangup);
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
