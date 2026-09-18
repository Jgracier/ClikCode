/** Native coding-harness delegation. Credentials and agent state stay with the vendor CLI. */
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

export interface NativeHarnessSpec {
  command: string;
  binary: string;
  displayName: string;
  surface?: 'terminal' | 'editor-extension';
  npmPackage?: string;
  loginArgv?: readonly string[];
  versionArgv?: readonly string[];
}

async function binaryOnPath(binary: string): Promise<boolean> {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    try { await access(join(dir, binary)); return true; } catch { /* try next */ }
  }
  return false;
}

export interface NativeHarnessInspection {
  installed: boolean;
  version?: string;
  error?: string;
}

/** Inspect availability without installing, logging in, or entering a vendor TUI. */
export async function inspectNativeHarness(spec: NativeHarnessSpec, timeoutMs = 5_000): Promise<NativeHarnessInspection> {
  if (spec.surface === 'editor-extension') return { installed: false, error: 'editor-extension-only' };
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
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', (error) => finish({ installed: true, error: error.message }));
    child.once('exit', (code, signal) => {
      const version = text.trim().split(/\r?\n/).find(Boolean)?.trim();
      if (code === 0) finish({ installed: true, ...(version ? { version } : {}) });
      else finish({ installed: true, ...(version ? { version } : {}), error: signal ? `version probe stopped (${signal})` : `version probe exited ${code ?? 1}` });
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ installed: true, error: 'version probe timed out' });
    }, timeoutMs);
    timer.unref();
  });
}

function run(command: string, args: readonly string[], envOverrides: Readonly<Record<string, string>> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: 'inherit', env: { ...process.env, ...envOverrides } });
    const forward = (signal: NodeJS.Signals): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    const onInterrupt = () => forward('SIGINT');
    const onTerminate = () => forward('SIGTERM');
    const onHangup = () => forward('SIGHUP');
    const cleanup = (): void => {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
      process.off('SIGHUP', onHangup);
    };
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    process.once('SIGHUP', onHangup);
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
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 64 * 1024) {
        exceededLimit = true;
        child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', (chunk: string) => { if (stderr.length < 16 * 1024) stderr += chunk; });
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => {
      if (exceededLimit) return finish(new Error(`${spec.displayName} helper output exceeded 64 KiB`));
      if (code !== 0) return finish(new Error(`${spec.binary} ${signal ? `stopped (${signal})` : `exited ${code ?? 1}`}${stderr.trim() ? `: ${stderr.trim().slice(-2000)}` : ''}`));
      finish();
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
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
        child.kill('SIGTERM');
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
      child.kill(signal);
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
      process.off('SIGHUP', onHangup);
      options.signal?.removeEventListener('abort', onAbort);
      if (abortStopTimer) clearTimeout(abortStopTimer);
    };
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    process.once('SIGHUP', onHangup);
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
