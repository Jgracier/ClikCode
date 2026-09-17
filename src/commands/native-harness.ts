/** Native coding-harness delegation. Credentials and agent state stay with the vendor CLI. */
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

export interface NativeHarnessSpec {
  command: string;
  binary: string;
  displayName: string;
  npmPackage?: string;
  loginArgv?: readonly string[];
}

async function binaryOnPath(binary: string): Promise<boolean> {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    try { await access(join(dir, binary)); return true; } catch { /* try next */ }
  }
  return false;
}

function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${signal ? `stopped (${signal})` : `exited ${code ?? 1}`}`));
    });
  });
}

/** Install only a vendor-declared npm package; never infer package names from user input. */
export async function ensureNativeHarness(spec: NativeHarnessSpec): Promise<void> {
  if (await binaryOnPath(spec.binary)) return;
  if (!spec.npmPackage) throw new Error(`${spec.displayName} is not installed. Install its official CLI, then retry /${spec.command}.`);
  await run('npm', ['install', '--global', spec.npmPackage]);
  if (!await binaryOnPath(spec.binary)) throw new Error(`${spec.displayName} installed but its binary is not on PATH; open a new terminal and retry.`);
}

/** Login is always performed by the vendor CLI in the user's terminal. */
export async function loginNativeHarness(spec: NativeHarnessSpec): Promise<void> {
  await ensureNativeHarness(spec);
  await run(spec.binary, spec.loginArgv ?? []);
}

/** Give the vendor's own TUI full control of the foreground terminal. */
export async function launchNativeHarness(spec: NativeHarnessSpec, args: readonly string[] = []): Promise<void> {
  await ensureNativeHarness(spec);
  await run(spec.binary, args);
}
