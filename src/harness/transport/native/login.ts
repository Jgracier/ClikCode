/** Handing the terminal to the vendor's own sign-in and watching what it
 * prints, without taking the terminal back from it. */

import { runLoginSession } from '../../../gateway/login/session.js';
import { NativeHarnessSpec } from './binary.js';
import { captureNativeHarnessOutput, run } from './command.js';
import { ensureNativeHarness } from './inspect.js';

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
  // The vendor owns the terminal, exactly as it always has. ClikCode watches
  // the output through script(1) and, on the first sign-in URL, copies it to
  // the terminal's clipboard and opens a browser where one is any use -- the
  // half no vendor does for a user on a phone. Where there is no script(1)
  // (Windows) this falls back to plain inherited stdio.
  const teed = await runLoginSession({
    binary: spec.binary, args: spec.loginArgv ?? [], env: envOverrides, displayName: spec.displayName,
    io: { write: (chunk) => process.stdout.write(chunk) },
  });
  if (!teed.teed) { await run(spec.binary, spec.loginArgv ?? [], envOverrides); return; }
  if (teed.exitCode !== 0 && teed.exitCode !== null) {
    throw new Error(`${spec.displayName} sign-in exited with status ${teed.exitCode}`);
  }
}
