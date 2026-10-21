/** Running one turn against a vendor CLI: the caps on how much of its output
 * is kept. The turn ends when the process does, or when the user stops it. */

import { lifecycle } from '../../../runtime/lifecycle-log.js';
import { markTurn } from '../../../runtime/turn-latency.js';
import { spawnFailure } from '../../../runtime/machine-folder.js';
import { killProcessTreePortable, spawnPortable as spawn } from '../spawn.js';
import { NativeHarnessSpec } from './binary.js';
import { ensureNativeHarness } from './inspect.js';
import { firstUsefulLine } from '../../protocol/stderr-line.js';
import { LineBuffer } from '../../protocol/json-lines.js';
import { interactiveLoginPrompt } from '../../../turn/failover.js';

interface NativeHarnessTurnOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  interrupted?: boolean;
  /** Set when streaming callbacks were supplied and the retained output is
   * only the newest tail of what the harness actually wrote. Every line was
   * still delivered to the callbacks; the head was dropped on a line boundary
   * so the retained stdout still parses as whole records. */
  truncated?: boolean;
}

/** A vendor's stdin, held open after the prompt so later messages can follow
 * it (see background-wait.ts). Created by the caller, bound by the turn. */
interface NativeTurnInput {
  /** Write to the running vendor; false once stdin is closed or gone. */
  write(text: string): boolean;
  /** Close stdin: the vendor's signal that no more input is coming. */
  end(): void;
}

interface BoundTurnInput extends NativeTurnInput {
  bind(stream: NodeJS.WritableStream | undefined): void;
}

export function createTurnInput(): NativeTurnInput {
  let stream: NodeJS.WritableStream | undefined;
  let ended = false;
  const input: BoundTurnInput = {
    write: (text) => {
      if (!stream || ended) return false;
      try { stream.write(text); return true; } catch { return false; }
    },
    end: () => {
      if (ended) return;
      ended = true;
      try { stream?.end(); } catch { /* the vendor already exited */ }
    },
    bind: (next) => {
      stream = next;
      // Closed before the vendor even started: close it on arrival.
      if (ended && next) try { next.end(); } catch { /* already gone */ }
    },
  };
  return input;
}

/** How a released vendor process eventually ended (see NativeTurnRelease). */
export interface ReleasedTurnExit {
  exitCode?: number;
  signalName?: string;
}

/** Ends a turn before its process does. A vendor that answered and is now
 * only minding background work it started (see background-wait.ts) keeps
 * running, but the ClikCode turn -- and the user's prompt -- is over. Created
 * by the caller, bound by the turn. */
interface NativeTurnRelease {
  /** Resolve the turn now with the output so far. The process keeps running,
   * its lines keep reaching `onStdoutLine`; the turn's abort signal no longer
   * reaches it. `onExit` is
   * called once, when it is gone. False when the turn already ended. */
  release(onExit: (exit: ReleasedTurnExit) => void): boolean;
  /** Stop a released process outright (SIGTERM, then SIGKILL). */
  terminate(): void;
}

interface BoundTurnRelease extends NativeTurnRelease {
  bind(target: { release(onExit: (exit: ReleasedTurnExit) => void): boolean; terminate(): void } | undefined): void;
}

export function createTurnRelease(): NativeTurnRelease {
  let target: { release(onExit: (exit: ReleasedTurnExit) => void): boolean; terminate(): void } | undefined;
  const handle: BoundTurnRelease = {
    release: (onExit) => target?.release(onExit) ?? false,
    terminate: () => target?.terminate(),
    bind: (next) => { target = next; },
  };
  return handle;
}

interface NativeHarnessTurnOptions {
  cwd?: string;
  stdinText?: string;
  /** Hold stdin open after `stdinText` instead of closing it; the caller
   * closes it through this once the vendor has nothing more to do. */
  input?: NativeTurnInput;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  /** See createTurnRelease. */
  release?: NativeTurnRelease;
}

/** Hard cap on retained output when nothing streams it away. */
const TURN_OUTPUT_LIMIT = 16 * 1024 * 1024;

/** Retained tail per stream when the caller consumes lines as they arrive. */
const TURN_OUTPUT_TAIL_LIMIT = 4 * 1024 * 1024;

/** A failed turn keeps its two streams apart: stderr is the vendor CLI's own
 * diagnostics and is safe to classify, stdout may be model-authored text that
 * merely *mentions* "rate limit" or "unauthorized". */
class NativeHarnessTurnError extends Error {
  stderrTail: string;
  stdoutTail: string;
  exitCode?: number;
  signalName?: string;
  reason: 'exit' | 'output-limit' | 'login-prompt';
  constructor(message: string, detail: {
    stderrTail: string; stdoutTail: string; exitCode?: number; signalName?: string;
    reason: 'exit' | 'output-limit' | 'login-prompt';
  }) {
    super(message);
    this.name = 'NativeHarnessTurnError';
    this.stderrTail = detail.stderrTail;
    this.stdoutTail = detail.stdoutTail;
    this.reason = detail.reason;
    if (detail.exitCode !== undefined) this.exitCode = detail.exitCode;
    if (detail.signalName !== undefined) this.signalName = detail.signalName;
  }
}

/** Keep the newest `limit` units, cut forward to a line boundary so the
 * retained text is still a sequence of whole records. */
function retainTail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const tail = text.slice(text.length - limit);
  const newline = tail.indexOf('\n');
  return newline >= 0 && newline < tail.length - 1 ? tail.slice(newline + 1) : tail;
}

/** How long to keep waiting for stdio to close after the process has exited.
 * A harness that left a background grandchild holding the pipe open would
 * otherwise never emit 'close' and hang a turn that is in fact finished. */
const STDIO_CLOSE_GRACE_MS = 2_000;

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
    const spawnedAt = Date.now();
    lifecycle('vendor.turn.spawn', { harness: spec.command, child: child.pid });
    // A one-shot CLI has no handshake: the prompt rides in its argv or on its
    // stdin from the moment it is spawned.
    markTurn('spawned', { reused: false, transport: 'cli' });
    markTurn('ready');
    markTurn('prompt-sent');
    child.once('close', (code, signal) => lifecycle('vendor.turn.exit', { harness: spec.command, child: child.pid, code, signal, ms: Date.now() - spawnedAt }));
    let stdout = '';
    let stderr = '';
    let exceededLimit = false;
    let truncated = false;
    let interrupted = false;
    let settled = false;
    const stdoutLines = new LineBuffer();
    const stopTimers: NodeJS.Timeout[] = [];
    let closeGraceTimer: NodeJS.Timeout | undefined;
    // A vendor with no sign-in starts its own browser login and waits for ever
    // on a stdin ClikCode closed (amp, aider: verified). That prompt is printed
    // before any work, so only the head of each stream is read for it -- model
    // text later in a turn can never trip it.
    let loginPrompt: string | undefined;
    const loginHead = { stdout: '', stderr: '' };
    const LOGIN_HEAD_LIMIT = 8_192;
    const tailLimit = TURN_OUTPUT_TAIL_LIMIT;
    const forward = (signal: NodeJS.Signals): void => killProcessTreePortable(child, signal, true);
    const later = (delayMs: number, signal: NodeJS.Signals): void => {
      const timer = setTimeout(() => forward(signal), delayMs);
      timer.unref();
      stopTimers.push(timer);
    };
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    const collect = (target: 'stdout' | 'stderr', chunk: string): void => {
      markTurn('first-byte');
      if (!loginPrompt && loginHead[target].length < LOGIN_HEAD_LIMIT) {
        loginHead[target] = (loginHead[target] + chunk).slice(0, LOGIN_HEAD_LIMIT);
        loginPrompt = interactiveLoginPrompt(loginHead[target]);
        if (loginPrompt) { forward('SIGTERM'); later(2_000, 'SIGKILL'); }
      }
      const callback = target === 'stdout' ? options.onStdoutLine : undefined;
      if (target === 'stdout') stdout += chunk;
      else stderr += chunk;
      // A consumed stream needs no full copy: every line already reached the
      // caller. Trim lazily (at 1.5x) so a long turn is not re-sliced per chunk.
      // stderr is diagnostics, only ever read from its tail, so it is always bounded.
      if (callback || target === 'stderr') {
        const held = target === 'stdout' ? stdout : stderr;
        if (held.length > tailLimit * 1.5) {
          truncated = true;
          if (target === 'stdout') stdout = retainTail(held, tailLimit);
          else stderr = retainTail(held, tailLimit);
        }
      }
      if (callback) {
        for (const line of stdoutLines.push(chunk)) {
          if (!line.trim()) continue;
          // A throwing consumer must not take the whole turn down with it (an
          // exception here would surface as an uncaught stream error).
          try { callback(line); } catch { /* fail-open-ok: presentation-only consumer */ }
        }
      }
      if (!exceededLimit && stdout.length + stderr.length > TURN_OUTPUT_LIMIT) {
        exceededLimit = true;
        forward('SIGTERM');
        later(2_000, 'SIGKILL');
      }
    };
    child.stdout!.on('data', (chunk: string) => collect('stdout', chunk));
    child.stderr!.on('data', (chunk: string) => collect('stderr', chunk));
    // A stream 'error' with no listener is an uncaught exception.
    child.stdout!.on('error', () => undefined);
    child.stderr!.on('error', () => undefined);
    if (options.stdinText !== undefined && child.stdin) {
      // EPIPE/ECONNRESET: the harness exited (bad flag, not logged in) before
      // reading its prompt. Its exit status and stderr carry the real reason;
      // an unhandled stream error here would crash ClikCode instead.
      child.stdin.on('error', () => undefined);
      const input = options.input as BoundTurnInput | undefined;
      if (input) {
        try { child.stdin.write(options.stdinText); } catch { /* reported through the child's exit */ }
        input.bind(child.stdin);
      } else {
        try { child.stdin.end(options.stdinText); } catch { /* reported through the child's exit */ }
      }
    }
    const onInterrupt = () => { interrupted = true; forward('SIGINT'); later(1_000, 'SIGTERM'); later(3_000, 'SIGKILL'); };
    const onAbort = onInterrupt;
    // Terminating or hanging up is stopping, as much as Ctrl+C is: the turn is
    // cancelled, never read as a vendor failure for failover to retry.
    const onTerminate = () => { interrupted = true; forward('SIGTERM'); later(2_000, 'SIGKILL'); };
    const onHangup = () => { interrupted = true; forward('SIGHUP'); later(2_000, 'SIGKILL'); };
    const cleanup = (): void => {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
      if (process.platform !== 'win32') process.off('SIGHUP', onHangup);
      options.signal?.removeEventListener('abort', onAbort);
      for (const timer of stopTimers.splice(0)) clearTimeout(timer);
      if (closeGraceTimer) clearTimeout(closeGraceTimer);
      options.input?.end();
    };
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    if (process.platform !== 'win32') process.once('SIGHUP', onHangup);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const tails = () => ({ stderrTail: stderr.trim().slice(-4000), stdoutTail: stdout.trim().slice(-4000) });
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      const stdoutTail = stdoutLines.flush();
      try { if (stdoutTail.trim()) options.onStdoutLine?.(stdoutTail); } catch { /* fail-open-ok: presentation-only consumer */ }
      const exit = { ...(code !== null ? { exitCode: code } : {}), ...(signal ? { signalName: signal } : {}) };
      if (onReleasedExit) {
        try { onReleasedExit(exit); } catch { /* fail-open-ok: the owner's bookkeeping */ }
        return;
      }
      if (loginPrompt && !interrupted) {
        return reject(new NativeHarnessTurnError(`${spec.displayName} needs you to sign in: ${loginPrompt}`, { ...tails(), stderrTail: loginPrompt, ...exit, reason: 'login-prompt' }));
      }
      if (exceededLimit) {
        return reject(new NativeHarnessTurnError(`${spec.displayName} turn output exceeded 16 MiB`, { ...tails(), ...exit, reason: 'output-limit' }));
      }
      const flags = truncated ? { truncated: true } : {};
      if (interrupted) return resolve({ stdout, stderr, exitCode: code ?? 130, interrupted: true, ...flags });
      if (code !== 0 && !stdout.trim()) {
        // The MESSAGE gets one line. The full tail still rides on the error
        // for classification and logs, but it is not what a person reads: a
        // crashing harness prints stack traces and absolute paths, and 4KB of
        // those used to land in the conversation as the explanation.
        const detail = firstUsefulLine(stderr);
        return reject(new NativeHarnessTurnError(
          `${spec.binary} ${signal ? `stopped (${signal})` : `exited ${code ?? 1}`}${detail ? `: ${detail}` : ''}`,
          { ...tails(), ...exit, reason: 'exit' },
        ));
      }
      resolve({ stdout, stderr, exitCode: code ?? 1, ...flags });
    };
    let onReleasedExit: ((exit: ReleasedTurnExit) => void) | undefined;
    (options.release as BoundTurnRelease | undefined)?.bind({
      release: (onExit) => {
        if (settled || onReleasedExit) return false;
        onReleasedExit = onExit;
        // The turn is over: stopping it no longer stops this process.
        options.signal?.removeEventListener('abort', onAbort);
        resolve({ stdout, stderr, exitCode: 0, ...(truncated ? { truncated: true } : {}) });
        return true;
      },
      terminate: () => { forward('SIGTERM'); later(2_000, 'SIGKILL'); },
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (onReleasedExit) {
        try { onReleasedExit({}); } catch { /* fail-open-ok: the owner's bookkeeping */ }
        return;
      }
      reject(spawnFailure(error, { name: spec.displayName, binary: spec.binary, cwd: options.cwd }));
    });
    // 'exit' fires when the process ends, which can be BEFORE its stdio pipes
    // have been drained: resolving there loses the last buffered line, which
    // for stream-json is the `result` record that says the turn succeeded.
    // 'close' fires once the streams have ended too.
    child.once('close', (code, signal) => finish(code, signal));
    child.once('exit', (code, signal) => {
      closeGraceTimer = setTimeout(() => finish(code, signal), STDIO_CLOSE_GRACE_MS);
      closeGraceTimer.unref();
    });
  });
}
