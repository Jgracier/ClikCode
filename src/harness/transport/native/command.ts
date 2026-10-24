/** Running one vendor command and keeping what it printed. */

import { spawnPortable as spawn, terminatePortable } from '../spawn.js';
import { NativeHarnessSpec, binaryOnPath } from './binary.js';
import { ensureNativeHarness } from './inspect.js';
import { failureText } from '../../protocol/stderr-line.js';
import { notInstalledMessage, spawnFailure } from '../../../runtime/machine-folder.js';

export function run(command: string, args: readonly string[], envOverrides: Readonly<Record<string, string>> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    // stdio must be fully 'inherit', not partially piped: confirmed live that
    // Antigravity's login (and plausibly others) checks that BOTH stdin and
    // stdout are real TTYs before attempting its interactive OAuth prompt at
    // all -- piping stdout alone (even with stdin still inherited, which was
    // tried here to auto-open a printed URL) made it fail in <1s with a
    // generic "run agy to log in" error instead of ever showing the prompt.
    const child = spawn(command, [...args], { stdio: 'inherit', env: { ...process.env, ...envOverrides } });
    const forward = (signal: NodeJS.Signals): void => {
      terminatePortable(child, signal);
    };
    const onInterrupt = () => forward('SIGINT');
    const onTerminate = () => forward('SIGTERM');
    const onHangup = () => forward('SIGHUP');
    const cleanup = (): void => {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
      if (process.platform !== 'win32') process.off('SIGHUP', onHangup);
    };
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    if (process.platform !== 'win32') process.once('SIGHUP', onHangup);
    child.once('error', (error) => {
      cleanup();
      reject(spawnFailure(error, { name: command, binary: command }));
    });
    child.once('exit', (code, signal) => {
      cleanup();
      if (code === 0) resolve();
      else reject(new Error(`${command} ${signal ? `stopped (${signal})` : `exited ${code ?? 1}`}`));
    });
  });
}

/** Run a declared vendor lifecycle command with foreground terminal ownership. */
export async function runNativeHarnessCommand(spec: NativeHarnessSpec, args: readonly string[], envOverrides: Readonly<Record<string, string>> = {}): Promise<void> {
  await ensureNativeHarness(spec);
  await run(spec.binary, args, envOverrides);
}

/** Run a documented machine-readable helper and return its small stdout value. */
export async function captureNativeHarness(spec: NativeHarnessSpec, args: readonly string[], envOverrides: Readonly<Record<string, string>> = {}): Promise<string> {
  const stdout = await captureNativeHarnessOutput(spec, args, envOverrides);
  const value = stdout.trim();
  if (!value) throw new Error(`${spec.displayName} did not return a native session id`);
  return value.split(/\s+/)[0];
}

/** Capture documented listing/helper output without invoking a shell. */
/** `stdinText` answers a vendor that asks a question. With stdin ignored a
 *  prompt reads EOF and takes its default, which for Hermes' "Save config
 *  anyway? [y/N]" is No -- so `mcp add` exited 0 having written nothing. */
const CAPTURE_LIMIT_BYTES = 2 * 1024 * 1024;
/** Bound on a helper's stderr held in memory (a runaway guard); the end is kept. */
const STDERR_KEEP = 256 * 1024;

export async function captureNativeHarnessOutput(spec: NativeHarnessSpec, args: readonly string[], envOverrides: Readonly<Record<string, string>> = {}, timeoutMs?: number, cwd?: string, stdinText?: string, signal?: AbortSignal): Promise<string> {
  // `timeoutMs` undefined or 0 is NO clock: the helper ends when the vendor
  // exits or errors, or when `signal` aborts (the user's cancel).
  // Never an install: this runs for probes (status, models, sessions, usage)
  // of harnesses nobody chose just now, and choosing is what installs one.
  // Everything that runs a harness because the user asked for it installed
  // it first (install.ts).
  if (!await binaryOnPath(spec.binary)) throw Object.assign(new Error(notInstalledMessage(spec.displayName, spec.binary)), { code: 'ENOENT' });
  return new Promise((resolve, reject) => {
    const child = spawn(spec.binary, [...args], { stdio: [stdinText === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], env: { ...process.env, ...envOverrides }, ...(cwd ? { cwd } : {}) });
    if (stdinText !== undefined) {
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(stdinText);
    }
    let stdout = '';
    let stderr = '';
    let exceededLimit = false;
    let settled = false;
    const onAbort = (): void => {
      terminatePortable(child);
      finish(new Error(`${spec.displayName} helper cancelled`));
    };
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(stdout);
    };
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      stdout += chunk;
      // A guard against a runaway child, not a size budget: OpenClaw's
      // `plugins list --json` is ~105 KiB and was cut off at the old 64 KiB.
      if (stdout.length > CAPTURE_LIMIT_BYTES) {
        exceededLimit = true;
        terminatePortable(child);
      }
    });
    // The newest output is kept: the cause is where the process stopped, not where it started.
    child.stderr!.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-STDERR_KEEP); });
    child.once('error', (error) => finish(spawnFailure(error, { name: spec.displayName, binary: spec.binary, cwd })));
    // `close`, not `exit`: exit can fire before the stdout pipe has drained,
    // and a child that prints its JSON and exits at once (OpenClaw) was read
    // back as empty.
    child.once('close', (code, killedBy) => {
      if (exceededLimit) return finish(new Error(`${spec.displayName} helper output exceeded ${CAPTURE_LIMIT_BYTES / 1024 / 1024} MiB`));
      if (code !== 0) return finish(new Error(`${spec.binary} ${killedBy ? `stopped (${killedBy})` : `exited ${code ?? 1}`}${failureText(stderr) ? `: ${failureText(stderr)}` : ''}`));
      finish();
    });
    timer = timeoutMs ? setTimeout(() => {
      terminatePortable(child);
      finish(new Error(`${spec.displayName} helper timed out`));
    }, timeoutMs) : undefined;
    timer?.unref();
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}
