/** Native coding-harness delegation. Credentials and agent state stay with the vendor CLI. */
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import { spawnPortable as spawn, terminatePortable } from './spawn-portable.js';
import { runLoginSession } from './login-session.js';

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
const pickerInspectionCache = new Map<string, { at: number; result: NativeHarnessInspection }>();
const INSPECTION_CACHE_TTL_MS = 60_000;

/** Picker-safe inspection: PATH lookup returns quickly. Do not start version
 * probes here: opening /provider can cover ~20 harnesses, and a burst of that
 * many background subprocesses still competes with terminal rendering even
 * though the picker no longer awaits them. */
export async function inspectNativeHarnessForPicker(spec: NativeHarnessSpec): Promise<NativeHarnessInspection> {
  if (spec.surface === 'editor-extension') return { installed: false, error: 'editor-extension-only' };
  const cached = inspectionCache.get(spec.command);
  if (cached && Date.now() - cached.at < INSPECTION_CACHE_TTL_MS) return cached.result;
  const pickerCached = pickerInspectionCache.get(spec.command);
  if (pickerCached && Date.now() - pickerCached.at < INSPECTION_CACHE_TTL_MS) return pickerCached.result;
  const result: NativeHarnessInspection = { installed: await binaryOnPath(spec.binary) };
  // A PATH-only answer must not masquerade as a full inspection (it has no
  // version), so an installed result stays in the picker's own cache. "Not
  // installed" is the same answer for both, so it can serve both.
  pickerInspectionCache.set(spec.command, { at: Date.now(), result });
  if (!result.installed) inspectionCache.set(spec.command, { at: Date.now(), result });
  return result;
}

/** Forget cached availability, e.g. right after installing a harness. */
export function clearNativeHarnessInspectionCache(command?: string): void {
  if (command === undefined) {
    inspectionCache.clear();
    pickerInspectionCache.clear();
    return;
  }
  inspectionCache.delete(command);
  pickerInspectionCache.delete(command);
}

/** Inspect availability without installing, logging in, or entering a vendor TUI. */
export async function inspectNativeHarness(spec: NativeHarnessSpec, timeoutMs = 5_000): Promise<NativeHarnessInspection> {
  if (spec.surface === 'editor-extension') return { installed: false, error: 'editor-extension-only' };
  const cached = inspectionCache.get(spec.command);
  if (cached && Date.now() - cached.at < INSPECTION_CACHE_TTL_MS) return cached.result;
  const result = await inspectNativeHarnessUncached(spec, timeoutMs);
  inspectionCache.set(spec.command, { at: Date.now(), result });
  pickerInspectionCache.set(spec.command, { at: Date.now(), result });
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
  clearNativeHarnessInspectionCache(spec.command);
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
  // Every harness gets the same treatment, because the vendors do not agree
  // on any of it: some auto-open and print nothing, some print a URL and no
  // more, some bury it in a JSON dump. ClikCode watches the login, and once a
  // sign-in URL appears it puts its own screen in front: the short link, the
  // clipboard copy, and one field wired to the vendor's stdin. Where there is
  // no script(1) (Windows), this falls back to the original
  // hand-the-terminal-over path, which is exactly today's behaviour.
  const teed = await runLoginSession({
    binary: spec.binary, args: spec.loginArgv ?? [], env: envOverrides, displayName: spec.displayName,
    io: { write: (chunk) => process.stdout.write(chunk), input: process.stdin },
  });
  if (!teed.teed) { await run(spec.binary, spec.loginArgv ?? [], envOverrides); return; }
  if (teed.exitCode !== 0 && teed.exitCode !== null) {
    throw new Error(`${spec.displayName} sign-in exited with status ${teed.exitCode}`);
  }
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
