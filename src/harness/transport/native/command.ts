/** Running one vendor command and keeping what it printed. */

import { killProcessTreePortable, spawnPortable as spawn, terminatePortable } from '../spawn.js';
import { forwardParentSignals } from '../parent-signals.js';
import { NativeHarnessSpec, binaryOnPath } from './binary.js';
import { ensureNativeHarness } from './inspect.js';
import { failureText } from '../../protocol/stderr-line.js';
import { notInstalledMessage, spawnFailure } from '../../../runtime/machine-folder.js';

function run(command: string, args: readonly string[], envOverrides: Readonly<Record<string, string>> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    // stdio must be fully 'inherit', not partially piped: confirmed live that
    // Antigravity's login (and plausibly others) checks that BOTH stdin and
    // stdout are real TTYs before attempting its interactive OAuth prompt at
    // all -- piping stdout alone (even with stdin still inherited, which was
    // tried here to auto-open a printed URL) made it fail in <1s with a
    // generic "run agy to log in" error instead of ever showing the prompt.
    const child = spawn(command, [...args], { stdio: 'inherit', env: { ...process.env, ...envOverrides } });
    const cleanup = forwardParentSignals((signal) => terminatePortable(child, signal));
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

/** Bound on a helper's output held in memory (a runaway guard, not a size
 * budget: OpenClaw's `plugins list --json` is ~105 KiB). */
const CAPTURE_LIMIT_BYTES = 2 * 1024 * 1024;
/** Bound on a helper's stderr held in memory (a runaway guard); the end is kept. */
const STDERR_KEEP = 256 * 1024;
/** The clock a helper gets when its caller names none. */
export const NATIVE_HELPER_TIMEOUT_MS = 120_000;

/** A vendor command run because the user asked for it -- a step of a turn
 * (creating the vendor's session), of a sign-in (storing a pasted key), of a
 * sign-out -- with its output kept. Nothing ClikCode runs on its own comes
 * here: background runs go through vendor-probe.ts, which refuses a profile
 * with no sign-in (a test holds the list of callers). Headless: stdin is
 * `stdinText` or nothing, the process leads its own group, and the clock
 * (`timeoutMs`, default NATIVE_HELPER_TIMEOUT_MS), `signal` or ClikCode's own
 * exit ends the whole group.
 *
 * `stdinText` answers a vendor that asks a question. With stdin ignored a
 * prompt reads EOF and takes its default, which for Hermes' "Save config
 * anyway? [y/N]" is No -- so `mcp add` exited 0 having written nothing. */
export async function captureNativeHarnessOutput(spec: NativeHarnessSpec, args: readonly string[], envOverrides: Readonly<Record<string, string>> = {}, timeoutMs: number = NATIVE_HELPER_TIMEOUT_MS, cwd?: string, stdinText?: string, signal?: AbortSignal): Promise<string> {
  // Never an install: everything that runs a harness because the user asked
  // for it installed it first (install.ts).
  if (!await binaryOnPath(spec.binary)) throw Object.assign(new Error(notInstalledMessage(spec.displayName, spec.binary)), { code: 'ENOENT' });
  const detached = process.platform !== 'win32';
  return new Promise((resolve, reject) => {
    const child = spawn(spec.binary, [...args], { stdio: [stdinText === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], env: { ...process.env, ...envOverrides }, detached, windowsHide: true, ...(cwd ? { cwd } : {}) });
    const stop = (): void => {
      killProcessTreePortable(child, 'SIGTERM', detached);
      const pid = child.pid;
      if (!detached || !pid) return;
      setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* fail-open-ok: gone */ } }, 2_000).unref();
    };
    // Its own group no longer hears the terminal's signals: ClikCode's
    // SIGTERM/SIGHUP or exit ends it. Not SIGINT: a listener there would keep
    // Ctrl+C from ending ClikCode.
    const unsignal = forwardParentSignals(() => stop(), ['SIGTERM', 'SIGHUP']);
    const onExit = (): void => { if (detached && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* fail-open-ok: gone */ } } };
    process.once('exit', onExit);
    const unforward = (): void => { unsignal(); process.off('exit', onExit); };
    if (stdinText !== undefined) {
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(stdinText);
    }
    let stdout = '';
    let stderr = '';
    let exceededLimit = false;
    let settled = false;
    const onAbort = (): void => {
      stop();
      finish(new Error(`${spec.displayName} helper cancelled`));
    };
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      unforward();
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      // Codex prints `login status` on stderr with an empty stdout. Prefer
      // stdout when the helper wrote any; otherwise keep stderr so status
      // checks are not silently empty.
      else resolve(stdout.trim() ? stdout : (stderr.trim() ? stderr : stdout));
    };
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      stdout += chunk;
      // A guard against a runaway child, not a size budget: OpenClaw's
      // `plugins list --json` is ~105 KiB and was cut off at the old 64 KiB.
      if (stdout.length > CAPTURE_LIMIT_BYTES) {
        exceededLimit = true;
        stop();
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
    timer = timeoutMs > 0 ? setTimeout(() => {
      stop();
      finish(new Error(`${spec.displayName} helper timed out`));
    }, timeoutMs) : undefined;
    timer?.unref();
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}
