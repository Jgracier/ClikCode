/** Runs one command and collects its output. The caller decides what may be said about it.
 *
 * The command runs in a process group of its own (POSIX), so stopping it -- on the timeout, on the caller's signal, or because
 * ClikCode itself exits -- reaches whatever it started too: SIGTERM to the group, then SIGKILL after a grace period. The result
 * comes when the command exits: a grandchild that inherited its stdout and stays alive cannot hold the answer back past a short
 * drain. A signal already aborted runs nothing. */
import { spawn, type ChildProcess } from 'node:child_process';

type CliResult = { code: number | null; text: string; missing: boolean };

/** How long a stopped command gets between SIGTERM and SIGKILL. */
export const KILL_GRACE_MS = 3_000;
/** How long output is still read after the command exited (a grandchild may hold the pipe open forever). */
const DRAIN_MS = 1_000;

const live = new Set<ChildProcess>();
let exitHookInstalled = false;
/** One process-exit hook for every running command (not one per call): what ClikCode started does not outlive it. Returns the
 * untrack; a child is untracked by itself when it exits. */
export function killOnExit(child: ChildProcess): () => void {
  live.add(child);
  const untrack = (): void => { live.delete(child); };
  child.once('exit', untrack);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => { for (const running of live) signalTree(running, 'SIGKILL'); });
  }
  return untrack;
}

/** SIGTERM to the child's group, then SIGKILL if it has not exited after `graceMs`: a stopped tool server gets to clean up
 * (close its browser tab) before anything is forced. */
export function stopTree(child: ChildProcess, graceMs: number = KILL_GRACE_MS): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalTree(child, 'SIGTERM');
  const timer = setTimeout(() => signalTree(child, 'SIGKILL'), graceMs);
  timer.unref?.();
  child.once('exit', () => clearTimeout(timer));
}

/** Signals the command's whole process group, or the command alone where there are no groups (Windows) or the group is gone. */
export function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, signal); return; } catch { /* fail-open-ok: the group is gone; the direct child below, if still there */ }
  }
  try { child.kill(signal); } catch { /* fail-open-ok: already gone */ }
}

export function runCli(command: string, argv: string[], options: { stdin?: string; signal?: AbortSignal; timeoutMs?: number; maxChars?: number; graceMs?: number } = {}): Promise<CliResult> {
  if (options.signal?.aborted) return Promise.resolve({ code: null, text: '', missing: false });
  return new Promise(resolve => {
    const child = spawn(command, argv, { stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    killOnExit(child);
    let text = '';
    let settled = false;
    let exited = false;
    let killTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    const keep = options.maxChars ?? 200_000;
    const stop = (): void => {
      if (exited || killTimer) return;
      signalTree(child, 'SIGTERM');
      killTimer = setTimeout(() => signalTree(child, 'SIGKILL'), options.graceMs ?? KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const timer = setTimeout(stop, options.timeoutMs ?? 90_000);
    options.signal?.addEventListener('abort', stop, { once: true });
    const finish = (result: CliResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); if (drainTimer) clearTimeout(drainTimer);
      options.signal?.removeEventListener('abort', stop);
      child.stdout?.destroy(); child.stderr?.destroy();
      resolve(result);
    };
    child.stdout!.on('data', chunk => { text = (text + String(chunk)).slice(-keep); });
    child.stderr!.on('data', chunk => { text = (text + String(chunk)).slice(-keep); });
    if (options.stdin !== undefined) { child.stdin!.on('error', () => undefined); child.stdin!.end(options.stdin); }
    child.once('error', error => { if (killTimer) clearTimeout(killTimer); finish({ code: null, text: '', missing: (error as NodeJS.ErrnoException).code === 'ENOENT' }); });
    child.once('exit', code => {
      exited = true;
      if (killTimer) clearTimeout(killTimer);
      // Whatever the command started in its group is ended with it: a leftover holding the pipe would otherwise run on.
      if (process.platform !== 'win32' && child.pid !== undefined) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* fail-open-ok: none left */ } }
      drainTimer = setTimeout(() => finish({ code, text, missing: false }), DRAIN_MS);
      child.once('close', () => finish({ code, text, missing: false }));
    });
  });
}
