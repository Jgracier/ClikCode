/** Native coding-harness delegation. Credentials and agent state stay with the vendor CLI. */
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import { spawnPortable as spawn, terminatePortable } from './spawn-portable.js';

export interface NativeHarnessSpec {
  command: string;
  binary: string;
  displayName: string;
  surface?: 'terminal' | 'editor-extension';
  npmPackage?: string;
  loginArgv?: readonly string[];
  loginCapturable?: boolean;
  versionArgv?: readonly string[];
}

export function executableNames(
  binary: string,
  platform: NodeJS.Platform = process.platform,
  pathExt = process.env.PATHEXT,
): string[] {
  if (platform !== 'win32' || extname(binary)) return [binary];
  const extensions = (pathExt || '.COM;.EXE;.BAT;.CMD').split(';').map((value) => value.trim()).filter(Boolean);
  return [binary, ...extensions.map((extension) => `${binary}${extension.startsWith('.') ? extension : `.${extension}`}`)];
}

export async function binaryOnPath(
  binary: string,
  options: { platform?: NodeJS.Platform; path?: string; pathExt?: string } = {},
): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  const names = executableNames(binary, platform, options.pathExt ?? process.env.PATHEXT);
  const directories = isAbsolute(binary) ? [''] : (options.path ?? process.env.PATH ?? '').split(platform === 'win32' ? ';' : delimiter);
  for (const rawDirectory of directories) {
    const directory = rawDirectory.replace(/^"|"$/g, '') || '.';
    for (const name of names) {
      const candidate = isAbsolute(name) ? name : join(directory, name);
      try {
        await access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
        return true;
      } catch { /* try next candidate */ }
    }
  }
  return false;
}

export interface NativeHarnessInspection {
  installed: boolean;
  version?: string;
  error?: string;
}

// Installation status barely ever changes mid-session -- a user isn't
// installing/uninstalling a CLI between one /provider open and the next --
// but every call here spawns a real subprocess per harness with its own
// timeout, and every /provider open queries all ~20 of them at once. With
// no cache, that meant however long the single slowest one took (up to its
// timeout) on *every single open* -- the concrete "a slash option takes a
// few seconds to render" report, since /provider is one of the most common
// commands. 60s is long enough to make repeated opens near-instant without
// meaningfully delaying noticing a harness someone actually just installed.
const inspectionCache = new Map<string, { at: number; result: NativeHarnessInspection }>();
const INSPECTION_CACHE_TTL_MS = 60_000;

/** Inspect availability without installing, logging in, or entering a vendor TUI. */
export async function inspectNativeHarness(spec: NativeHarnessSpec, timeoutMs = 5_000): Promise<NativeHarnessInspection> {
  if (spec.surface === 'editor-extension') return { installed: false, error: 'editor-extension-only' };
  const cached = inspectionCache.get(spec.command);
  if (cached && Date.now() - cached.at < INSPECTION_CACHE_TTL_MS) return cached.result;
  const result = await inspectNativeHarnessUncached(spec, timeoutMs);
  inspectionCache.set(spec.command, { at: Date.now(), result });
  return result;
}

async function inspectNativeHarnessUncached(spec: NativeHarnessSpec, timeoutMs: number): Promise<NativeHarnessInspection> {
  if (!await binaryOnPath(spec.binary)) return { installed: false };
  return new Promise((resolve) => {
    const child = spawn(spec.binary, [...(spec.versionArgv ?? ['--version'])], {
      stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
    });
    let text = '';
    let settled = false;
    const finish = (result: NativeHarnessInspection): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const collect = (chunk: Buffer | string): void => {
      if (text.length < 4096) text += String(chunk);
    };
    child.stdout!.on('data', collect);
    child.stderr!.on('data', collect);
    child.once('error', (error) => finish({ installed: true, error: error.message }));
    child.once('exit', (code, signal) => {
      const version = text.trim().split(/\r?\n/).find(Boolean)?.trim();
      if (code === 0) finish({ installed: true, ...(version ? { version } : {}) });
      else finish({ installed: true, ...(version ? { version } : {}), error: signal ? `version probe stopped (${signal})` : `version probe exited ${code ?? 1}` });
    });
    const timer = setTimeout(() => {
      terminatePortable(child);
      finish({ installed: true, error: 'version probe timed out' });
    }, timeoutMs);
    timer.unref();
  });
}

function run(command: string, args: readonly string[], envOverrides: Readonly<Record<string, string>> = {}): Promise<void> {
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

/** Install only a vendor-declared npm package; never infer package names from user input. */
export async function ensureNativeHarness(spec: NativeHarnessSpec): Promise<void> {
  if (spec.surface === 'editor-extension') {
    throw new Error(`${spec.displayName} is an editor extension, not a standalone terminal harness; ClikCode cannot broker it as a native TUI.`);
  }
  if (await binaryOnPath(spec.binary)) return;
  if (!spec.npmPackage) {
    throw new Error(`${spec.displayName} does not publish an npm package ClikCode can install automatically. Install ${spec.displayName}'s official CLI yourself (it must put a \`${spec.binary}\` binary on PATH), then retry /${spec.command}.`);
  }
  await run('npm', ['install', '--global', spec.npmPackage]);
  if (!await binaryOnPath(spec.binary)) throw new Error(`${spec.displayName} installed but its binary is not on PATH; open a new terminal and retry.`);
}

/** Login is always performed by the vendor CLI in the user's terminal. */
export async function loginNativeHarness(spec: NativeHarnessSpec, envOverrides: Readonly<Record<string, string>> = {}): Promise<void> {
  await ensureNativeHarness(spec);
  if (spec.loginCapturable) {
    // Confirmed live for Antigravity CLI: its login turn authenticates via
    // an OS-level browser trigger, not by printing anything the user needs
    // to see or read a pasted code back from -- captured stdout still lets
    // that happen, and keeps the caller's own UI on screen the whole time
    // instead of suspending it to hand over a terminal nothing here needs.
    const stdout = await captureNativeHarnessOutput(spec, spec.loginArgv ?? [], envOverrides, 60_000);
    try {
      const parsed = JSON.parse(stdout.trim().split('\n').pop() ?? '') as { status?: string; error?: string };
      if (parsed.status === 'ERROR' && parsed.error) throw new Error(`${spec.displayName} sign-in failed: ${parsed.error}`);
    } catch (error) {
      if (error instanceof SyntaxError) return; // fail-open-ok: not JSON, no structured failure to report
      throw error;
    }
    return;
  }
  await run(spec.binary, spec.loginArgv ?? [], envOverrides);
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
export async function captureNativeHarnessOutput(spec: NativeHarnessSpec, args: readonly string[], envOverrides: Readonly<Record<string, string>> = {}, timeoutMs = 15_000, cwd?: string): Promise<string> {
  await ensureNativeHarness(spec);
  return new Promise((resolve, reject) => {
    const child = spawn(spec.binary, [...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...envOverrides }, ...(cwd ? { cwd } : {}) });
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
      if (stdout.length > 64 * 1024) {
        exceededLimit = true;
        terminatePortable(child);
      }
    });
    child.stderr!.on('data', (chunk: string) => { if (stderr.length < 16 * 1024) stderr += chunk; });
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => {
      if (exceededLimit) return finish(new Error(`${spec.displayName} helper output exceeded 64 KiB`));
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

export interface NativeHarnessTurnOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  interrupted?: boolean;
}

export interface NativeHarnessTurnOptions {
  cwd?: string;
  stdinText?: string;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

/** Run one provider turn without surrendering the ClikCode terminal UI. */
export async function captureNativeHarnessTurn(
  spec: NativeHarnessSpec,
  args: readonly string[],
  envOverrides: Readonly<Record<string, string>> = {},
  options: NativeHarnessTurnOptions = {},
): Promise<NativeHarnessTurnOutput> {
  await ensureNativeHarness(spec);
  return new Promise((resolve, reject) => {
    const child = spawn(spec.binary, [...args], {
      stdio: [options.stdinText === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...envOverrides },
      detached: process.platform !== 'win32',
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
    let stdout = '';
    let stderr = '';
    let exceededLimit = false;
    let interrupted = false;
    let stdoutPending = '';
    let stderrPending = '';
    let abortStopTimer: NodeJS.Timeout | undefined;
    const limit = 16 * 1024 * 1024;
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    const collect = (target: 'stdout' | 'stderr', chunk: string): void => {
      if (target === 'stdout') stdout += chunk;
      else stderr += chunk;
      let pending = (target === 'stdout' ? stdoutPending : stderrPending) + chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      if (target === 'stdout') stdoutPending = pending;
      else stderrPending = pending;
      const callback = target === 'stdout' ? options.onStdoutLine : options.onStderrLine;
      if (callback) for (const line of lines) if (line.trim()) callback(line);
      if (stdout.length + stderr.length > limit) {
        exceededLimit = true;
        terminatePortable(child);
      }
    };
    child.stdout!.on('data', (chunk: string) => collect('stdout', chunk));
    child.stderr!.on('data', (chunk: string) => collect('stderr', chunk));
    if (options.stdinText !== undefined) child.stdin!.end(options.stdinText);
    const forward = (signal: NodeJS.Signals): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, signal); return; } catch { /* fall back to the direct child */ }
      }
      terminatePortable(child, signal);
    };
    const onInterrupt = () => { interrupted = true; forward('SIGINT'); };
    const onAbort = () => {
      interrupted = true;
      forward('SIGINT');
      abortStopTimer = setTimeout(() => forward('SIGTERM'), 1_000);
      abortStopTimer.unref();
    };
    const onTerminate = () => forward('SIGTERM');
    const onHangup = () => forward('SIGHUP');
    const cleanup = (): void => {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
      if (process.platform !== 'win32') process.off('SIGHUP', onHangup);
      options.signal?.removeEventListener('abort', onAbort);
      if (abortStopTimer) clearTimeout(abortStopTimer);
    };
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    if (process.platform !== 'win32') process.once('SIGHUP', onHangup);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      cleanup();
      if (stdoutPending.trim()) options.onStdoutLine?.(stdoutPending);
      if (stderrPending.trim()) options.onStderrLine?.(stderrPending);
      if (exceededLimit) return reject(new Error(`${spec.displayName} turn output exceeded 16 MiB`));
      if (interrupted) return resolve({ stdout, stderr, exitCode: code ?? 130, interrupted: true });
      if (code !== 0 && !stdout.trim()) {
        const detail = stderr.trim().slice(-4000) || stdout.trim().slice(-4000);
        return reject(new Error(`${spec.binary} ${signal ? `stopped (${signal})` : `exited ${code ?? 1}`}${detail ? `: ${detail}` : ''}`));
      }
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}
