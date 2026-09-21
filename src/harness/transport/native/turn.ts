/** Running one turn against a vendor CLI: the idle timers that decide a
 * silent harness has stopped, and the caps on how much of its output is
 * kept. */

import { spawnPortable as spawn, terminatePortable } from '../spawn.js';
import { NativeHarnessSpec } from './binary.js';
import { ensureNativeHarness } from './inspect.js';

export interface NativeHarnessTurnOutput {
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

/** Lets the caller tell the idle watchdog what it has learned from the stream.
 * A harness running a long silent build says nothing for many minutes, yet is
 * not hung: the caller saw the tool start and has not seen it finish. */
export interface NativeTurnIdleController {
  /** Any externally observed sign of life; restarts the idle countdown. */
  noteActivity(): void;
  /** A tool began. While any tool is outstanding the (much longer) tool idle
   * budget applies instead of the ordinary one. */
  toolStarted(id?: string): void;
  /** A tool finished or failed. */
  toolFinished(id?: string): void;
  /** Number of tools believed to be running right now. */
  readonly runningTools: number;
}

interface BoundIdleController extends NativeTurnIdleController {
  bind(listener: (() => void) | undefined): void;
}

export function createTurnIdleController(): NativeTurnIdleController {
  const running = new Set<string>();
  let anonymous = 0;
  let listener: (() => void) | undefined;
  const controller: BoundIdleController = {
    noteActivity: () => listener?.(),
    toolStarted: (id) => {
      if (id) running.add(id);
      else anonymous += 1;
      listener?.();
    },
    toolFinished: (id) => {
      // A completion whose start was never seen (or carries no id) still
      // settles one outstanding tool rather than leaving the long budget armed.
      if (id && running.delete(id)) { /* paired */ } else if (anonymous > 0) anonymous -= 1;
      else if (!id && running.size > 0) running.delete(running.values().next().value as string);
      listener?.();
    },
    get runningTools() { return running.size + anonymous; },
    bind: (next) => { listener = next; },
  };
  return controller;
}

/** Feed a parsed activity event to the watchdog: the one call a streaming
 * caller needs to keep long-running tools from being mistaken for a hang. */
export function noteTurnActivityEvent(
  controller: NativeTurnIdleController | undefined,
  event: { kind: 'thinking' | 'tool-start' | 'tool-done' | 'tool-error'; id?: string } | undefined,
): void {
  if (!controller || !event) return;
  if (event.kind === 'tool-start') controller.toolStarted(event.id);
  else if (event.kind === 'tool-done' || event.kind === 'tool-error') controller.toolFinished(event.id);
  else controller.noteActivity();
}

export interface NativeHarnessTurnOptions {
  cwd?: string;
  stdinText?: string;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** Milliseconds of complete silence -- no stdout, no stderr, no exit --
   * after which the harness is treated as hung. Zero or negative disables it. */
  idleTimeoutMs?: number;
  /** Silence budget while `idleController` reports a running tool. Defaults to
   * DEFAULT_TOOL_IDLE_TIMEOUT_MS; zero or negative disables the watchdog for
   * as long as a tool is running. */
  toolIdleTimeoutMs?: number;
  /** See NativeTurnIdleController. Create with createTurnIdleController(). */
  idleController?: NativeTurnIdleController;
  /** Newest bytes (UTF-16 units) of each stream retained when that stream has
   * a line callback. Defaults to TURN_OUTPUT_TAIL_LIMIT. */
  retainTailLimit?: number;
}

/** Deliberately an *idle* timeout rather than a wall-clock cap: a legitimate
 * agentic turn can run for a very long time, but it narrates while it does.
 * A harness that has said nothing at all for this long is wedged, and without
 * this the turn blocks forever with only Ctrl+C to break it. */
export const DEFAULT_TURN_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** A build or test suite can legitimately be silent far longer than a model. */
export const DEFAULT_TOOL_IDLE_TIMEOUT_MS = 60 * 60 * 1000;

/** Hard cap on retained output when nothing streams it away. */
export const TURN_OUTPUT_LIMIT = 16 * 1024 * 1024;

/** Retained tail per stream when the caller consumes lines as they arrive. */
export const TURN_OUTPUT_TAIL_LIMIT = 4 * 1024 * 1024;

export function turnIdleTimeoutMs(
  override?: number, environment: NodeJS.ProcessEnv = process.env,
): number {
  if (override !== undefined) return override;
  const configured = Number(environment.CLIKCODE_TURN_IDLE_TIMEOUT_MS);
  return Number.isFinite(configured) && environment.CLIKCODE_TURN_IDLE_TIMEOUT_MS !== undefined && environment.CLIKCODE_TURN_IDLE_TIMEOUT_MS !== ''
    ? configured
    : DEFAULT_TURN_IDLE_TIMEOUT_MS;
}

/** The one line worth showing a person out of a failed harness's stderr.
 *
 * Vendor CLIs fail loudly: stack frames, module resolution traces, absolute
 * paths, sometimes a JSON blob. The first line that is none of those is
 * almost always the actual complaint, and it is all that belongs on screen.
 */
export function firstUsefulLine(stderr: string, limit = 200): string {
  // Stack frames, brackets, bare paths, carets, and the runtime's own
  // `throw err;` line -- none of them is the complaint.
  const noise = /^\s*(?:at\s|[{}[\]]|"|\/|[A-Za-z]:\\|\.{3}|Require stack|throw\s|\^+\s*$|node:internal)/;
  const lines = stderr.split(/\r?\n/).filter((line) => line.trim() && !noise.test(line));
  const cut = (text: string): string =>
    text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}\u2026` : text;
  // The line that names the error wins over whatever merely came first: a
  // runtime prints its banner lines before the message they belong to.
  const named = lines.find((line) => /\berror\b/i.test(line));
  if (named) return cut(named.trim());
  if (lines.length) return cut(lines[0]!.trim());
  const fallback = stderr.trim().split(/\r?\n/)[0]?.trim() ?? '';
  return cut(fallback);
}

/** A failed turn keeps its two streams apart: stderr is the vendor CLI's own
 * diagnostics and is safe to classify, stdout may be model-authored text that
 * merely *mentions* "rate limit" or "unauthorized". */
export class NativeHarnessTurnError extends Error {
  stderrTail: string;
  stdoutTail: string;
  exitCode?: number;
  signalName?: string;
  reason: 'exit' | 'idle-timeout' | 'output-limit';
  constructor(message: string, detail: {
    stderrTail: string; stdoutTail: string; exitCode?: number; signalName?: string;
    reason: 'exit' | 'idle-timeout' | 'output-limit';
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
    let stdout = '';
    let stderr = '';
    let exceededLimit = false;
    let truncated = false;
    let interrupted = false;
    let settled = false;
    let exited = false;
    let stdoutPending = '';
    let stderrPending = '';
    const stopTimers: NodeJS.Timeout[] = [];
    let idleTimer: NodeJS.Timeout | undefined;
    let closeGraceTimer: NodeJS.Timeout | undefined;
    let timedOut = false;
    let timedOutAfterMs = 0;
    const idleLimit = turnIdleTimeoutMs(options.idleTimeoutMs);
    const toolIdleLimit = options.toolIdleTimeoutMs ?? DEFAULT_TOOL_IDLE_TIMEOUT_MS;
    const controller = options.idleController as BoundIdleController | undefined;
    const tailLimit = Math.max(1024, options.retainTailLimit ?? TURN_OUTPUT_TAIL_LIMIT);
    const forward = (signal: NodeJS.Signals): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, signal); return; } catch { /* fall back to the direct child */ }
      }
      terminatePortable(child, signal);
    };
    const later = (delayMs: number, signal: NodeJS.Signals): void => {
      const timer = setTimeout(() => forward(signal), delayMs);
      timer.unref();
      stopTimers.push(timer);
    };
    const noteActivity = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = undefined;
      if (settled || timedOut || exited) return;
      // The tool budget only ever lengthens the deadline: a caller who disabled
      // or raised the ordinary budget must not have it shortened by a tool.
      const toolRunning = (controller?.runningTools ?? 0) > 0;
      const budget = idleLimit <= 0 ? idleLimit
        : toolRunning ? (toolIdleLimit <= 0 ? toolIdleLimit : Math.max(idleLimit, toolIdleLimit)) : idleLimit;
      if (budget <= 0) return;
      idleTimer = setTimeout(() => {
        timedOut = true;
        timedOutAfterMs = budget;
        forward('SIGTERM');
        later(2_000, 'SIGKILL');
      }, budget);
      idleTimer.unref();
    };
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    const collect = (target: 'stdout' | 'stderr', chunk: string): void => {
      noteActivity();
      const callback = target === 'stdout' ? options.onStdoutLine : options.onStderrLine;
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
      let pending = (target === 'stdout' ? stdoutPending : stderrPending) + chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      if (target === 'stdout') stdoutPending = pending;
      else stderrPending = pending;
      if (callback) {
        for (const line of lines) {
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
      try { child.stdin.end(options.stdinText); } catch { /* reported through the child's exit */ }
    }
    const onInterrupt = () => { interrupted = true; forward('SIGINT'); later(1_000, 'SIGTERM'); later(3_000, 'SIGKILL'); };
    const onAbort = () => {
      interrupted = true;
      forward('SIGINT');
      later(1_000, 'SIGTERM');
      later(3_000, 'SIGKILL');
    };
    const onTerminate = () => { forward('SIGTERM'); later(2_000, 'SIGKILL'); };
    const onHangup = () => { forward('SIGHUP'); later(2_000, 'SIGKILL'); };
    const cleanup = (): void => {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
      if (process.platform !== 'win32') process.off('SIGHUP', onHangup);
      options.signal?.removeEventListener('abort', onAbort);
      for (const timer of stopTimers.splice(0)) clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      if (closeGraceTimer) clearTimeout(closeGraceTimer);
      controller?.bind?.(undefined);
    };
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    if (process.platform !== 'win32') process.once('SIGHUP', onHangup);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    controller?.bind?.(noteActivity);
    if (options.signal?.aborted) onAbort();
    noteActivity();
    const tails = () => ({ stderrTail: stderr.trim().slice(-4000), stdoutTail: stdout.trim().slice(-4000) });
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try { if (stdoutPending.trim()) options.onStdoutLine?.(stdoutPending); } catch { /* fail-open-ok: presentation-only consumer */ }
      try { if (stderrPending.trim()) options.onStderrLine?.(stderrPending); } catch { /* fail-open-ok: presentation-only consumer */ }
      const exit = { ...(code !== null ? { exitCode: code } : {}), ...(signal ? { signalName: signal } : {}) };
      if (exceededLimit) {
        return reject(new NativeHarnessTurnError(`${spec.displayName} turn output exceeded 16 MiB`, { ...tails(), ...exit, reason: 'output-limit' }));
      }
      if (timedOut) {
        return reject(new NativeHarnessTurnError(
          `${spec.displayName} produced no output for ${Math.round(timedOutAfterMs / 1000)}s and was stopped`,
          { ...tails(), ...exit, reason: 'idle-timeout' },
        ));
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
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    // 'exit' fires when the process ends, which can be BEFORE its stdio pipes
    // have been drained: resolving there loses the last buffered line, which
    // for stream-json is the `result` record that says the turn succeeded.
    // 'close' fires once the streams have ended too.
    child.once('close', (code, signal) => finish(code, signal));
    child.once('exit', (code, signal) => {
      exited = true;
      if (idleTimer) clearTimeout(idleTimer);
      closeGraceTimer = setTimeout(() => finish(code, signal), STDIO_CLOSE_GRACE_MS);
      closeGraceTimer.unref();
    });
  });
}
