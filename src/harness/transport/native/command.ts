/** Running one vendor command and keeping what it printed. */

import { spawnPortable as spawn, terminatePortable } from '../spawn.js';
import { NativeHarnessSpec } from './binary.js';
import { ensureNativeHarness } from './inspect.js';

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
      reject(error);
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

export async function captureNativeHarnessOutput(spec: NativeHarnessSpec, args: readonly string[], envOverrides: Readonly<Record<string, string>> = {}, timeoutMs = 15_000, cwd?: string, stdinText?: string): Promise<string> {
  await ensureNativeHarness(spec);
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
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
    child.stderr!.on('data', (chunk: string) => { if (stderr.length < 16 * 1024) stderr += chunk; });
    child.once('error', (error) => finish(error));
    // `close`, not `exit`: exit can fire before the stdout pipe has drained,
    // and a child that prints its JSON and exits at once (OpenClaw) was read
    // back as empty.
    child.once('close', (code, signal) => {
      if (exceededLimit) return finish(new Error(`${spec.displayName} helper output exceeded ${CAPTURE_LIMIT_BYTES / 1024 / 1024} MiB`));
      if (code !== 0) return finish(new Error(`${spec.binary} ${signal ? `stopped (${signal})` : `exited ${code ?? 1}`}${stderr.trim() ? `: ${stderr.trim().slice(-2000)}` : ''}`));
      finish();
    });
    const timer = setTimeout(() => {
      terminatePortable(child);
      finish(new Error(`${spec.displayName} helper timed out`));
    }, timeoutMs);
    timer.unref();
  });
}
