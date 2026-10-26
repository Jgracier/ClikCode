/** What every ClikCode process did, in order, in one place.
 *
 * A window (the TUI), a session worker, an editor bridge and a one-off
 * command each write the moments that explain a report: started and exited
 * (with why), the mode a window is in (prompt, turn, picker, sign-in,
 * suspended), a worker's turns and what holds it up or lets it go, vendor
 * processes spawned and how they ended, background work, sign-ins. One JSON
 * object per line in <home>/logs/lifecycle.log, shared by every process:
 *
 *   {"t":"…","pid":123,"role":"worker","session":"…","event":"turn.end","outcome":"completed","ms":4210}
 *
 * Bounded by size, never by a count per process: cursor.log stops after 60
 * frames a process, and a gap that was only the cap read as the window
 * having stopped drawing. Past ROTATE_BYTES the file moves to .1.
 *
 * Never throws, never writes prompt or answer text, and never creates a
 * ClikCode home that is not there (a deleted test home stays deleted). */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stateDirectory } from '../session/store/paths.js';
import { subscribe } from 'node:diagnostics_channel';
import { basename } from 'node:path';
import { redactForLog } from './redact.js';

type LifecycleRole = 'window' | 'worker' | 'bridge' | 'command';

const ROTATE_BYTES = 10 * 1024 * 1024;
const ROTATE_CHECK_EVERY = 200;

let role: LifecycleRole = 'command';
let session: string | undefined;
let linesSinceCheck = ROTATE_CHECK_EVERY;

/** Who this process is, and (when it has one) the conversation it serves. */
export function setLifecycleRole(next: LifecycleRole, sessionId?: string): void {
  role = next;
  if (sessionId !== undefined) session = sessionId;
}

/** The conversation this process serves now (a window switches). */
export function setLifecycleSession(sessionId: string | undefined): void {
  session = sessionId;
}

/** A process serving several conversations at once (an editor's shared
 * bridge) names the one the code that is logging runs for. */
let sessionSource: (() => string | undefined) | undefined;
export function setLifecycleSessionSource(source: (() => string | undefined) | undefined): void {
  sessionSource = source;
}

export function lifecycleLogPath(): string {
  return join(stateDirectory(), 'logs', 'lifecycle.log');
}

function enabled(): boolean {
  // CLIKCODE_LIFECYCLE_LOG=0 turns the log off. The test setup sets it (the
  // suite drives many processes against throwaway homes; the workers it spawns
  // inherit it); a test that wants the log sets it to 1.
  return process.env.CLIKCODE_LIFECYCLE_LOG !== '0';
}

/** Record one moment. `fields` are small facts -- ids, counts, reasons,
 * outcomes -- never text a user or model wrote. */
export function lifecycle(event: string, fields: Readonly<Record<string, unknown>> = {}): void {
  if (!enabled()) return;
  try {
    const home = stateDirectory();
    if (!existsSync(home)) return;
    const dir = join(home, 'logs');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, 'lifecycle.log');
    if (++linesSinceCheck >= ROTATE_CHECK_EVERY) {
      linesSinceCheck = 0;
      try { if (statSync(path).size > ROTATE_BYTES) renameSync(path, `${path}.1`); } catch { /* fail-open-ok: absent, or another process rotated it */ }
    }
    // Who wrote it last, so a fact can never pass for the writer's own pid.
    const current = sessionSource ? sessionSource() : session;
    const line = JSON.stringify({ ...fields, t: new Date().toISOString(), pid: process.pid, role, ...(current ? { session: current } : {}), event });
    appendFileSync(path, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch { /* fail-open-ok: logging must never break what it records */ }
}

/** Something that went wrong or was decided on the user's behalf and is not
 * worth interrupting them for: ClikCode's log is where it goes, never the chat.
 * `kind` is a short stable name; `message` the one line of why. */
export function diagnostic(kind: string, message: string): void {
  lifecycle('note', { kind, message: redactForLog(message).slice(0, 300) });
}

/** What is not worth a line: the file that was not there, the process already gone, a request
 * the person cancelled. */
const BENIGN_CODES = new Set(['ENOENT', 'ESRCH', 'ECANCELED', 'EEXIST', 'ENOTEMPTY']);
const QUIET_WINDOW_MS = 60_000;
const quietSeen = new Map<string, { at: number; skipped: number }>();

/** One line per area per minute, and how many more came in between. */
function oncePerWindow(key: string): { more: number } | undefined {
  const now = Date.now();
  const seen = quietSeen.get(key);
  if (seen && now - seen.at < QUIET_WINDOW_MS) { seen.skipped += 1; return undefined; }
  quietSeen.set(key, { at: now, skipped: 0 });
  if (quietSeen.size > 500) quietSeen.delete(quietSeen.keys().next().value as string);
  return { more: seen?.skipped ?? 0 };
}

/** An error nothing will act on -- a best-effort write, a check that may fail -- written down
 * rather than dropped. The work goes on exactly as before; the log learns that it failed, once
 * a minute per `area` with a count, so a path that fails on every call is a line, not a flood.
 * `area` is where it happened (`worker/session-worker`); a person searching the log finds it by
 * that name. */
export function swallowed(area: string, error: unknown): undefined {
  const code = errnoOf(error);
  if (code && BENIGN_CODES.has(code)) return undefined;
  if ((error as { name?: unknown } | null | undefined)?.name === 'AbortError') return undefined;
  const window = oncePerWindow(`swallowed:${area}`);
  if (!window) return undefined;
  const message = error instanceof Error ? error.message : String(error ?? '');
  lifecycle('swallowed', { area, ...(code ? { errno: code } : {}), message: redactForLog(message).slice(0, 200), ...(window.more ? { more: window.more } : {}) });
  return undefined;
}

/** `.catch(quiet('area'))`: swallowed(), as a promise's rejection handler. */
export const quiet = (area: string) => (error: unknown): undefined => swallowed(area, error);

let childrenObserved = false;

/** Every child process this one starts, by the runtime's own channel -- `spawn`, `execFile`, the
 * promisified forms, a command that does not exist -- so no call site has to say so. Only a
 * failure is written (a non-zero exit, a signal, a process that never started), per command per
 * minute: what ran is the person's, not the log's, so the line names the program and how many
 * arguments it had, never what they were. */
export function observeChildProcesses(): void {
  if (childrenObserved) return;
  childrenObserved = true;
  subscribe('child_process', (message) => {
    const child = (message as { process?: import('node:child_process').ChildProcess }).process;
    if (!child) return;
    const startedAt = Date.now();
    const report = (how: Record<string, unknown>): void => {
      const program = basename(child.spawnfile || 'unknown').slice(0, 40);
      const window = oncePerWindow(`child:${program}:${String(how.errno ?? how.code ?? how.signal ?? '')}`);
      if (window) lifecycle('child.failed', { program, argc: Math.max(0, (child.spawnargs?.length ?? 1) - 1), ms: Date.now() - startedAt, ...how, ...(window.more ? { more: window.more } : {}) });
    };
    child.once('error', (error) => report({ errno: errnoOf(error) ?? 'error' }));
    child.once('exit', (code, signal) => { if (code !== 0) report({ ...(code !== null ? { code } : {}), ...(signal ? { signal } : {}) }); });
  });
}

let exitHooked = false;

/** The name of the process that started this one (`claude`, `codex`, `node`), where the
 * system says so (Linux /proc). It is what tells a vendor's launch of a stale command from a
 * person's: without it a process that starts, fails and exits is only a line. */
function errnoOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

export function parentProcessName(): string | undefined {
  try { return readFileSync(`/proc/${process.ppid}/comm`, 'utf8').trim().slice(0, 40) || undefined; } catch { return undefined; }
}

/** Log this process's start, and its end: an exit with its code, and an
 * uncaught error with its message (crash.log keeps the stack). */
export function lifecycleProcess(details: Readonly<Record<string, unknown>> = {}): void {
  const argv = process.argv.slice(2, 4).join(' ');
  const parent = parentProcessName();
  const startedAt = Date.now();
  observeChildProcesses();
  lifecycle('process.start', { argv, ppid: process.ppid, ...(parent ? { parent } : {}), node: process.version, ...details });
  if (exitHooked) return;
  exitHooked = true;
  // The exit line stands alone: what ran, who started it, how long it lived and how it ended, so a
  // failing command is named without joining it back to its start by pid.
  process.on('exit', (code) => lifecycle('process.exit', { code, argv, ...(parent ? { parent } : {}), ms: Date.now() - startedAt }));
  // A process ended by a signal it does not handle never reaches 'exit': a start with no end, which
  // is how 109 in a day looked. Say which signal, then die of it exactly as before -- unless
  // something else listens (a worker's graceful shutdown, a window's hangup guard), in which case
  // that is left to do what it does and this only writes it down.
  for (const signal of ['SIGTERM', 'SIGHUP'] as const) {
    const onSignal = (): void => {
      lifecycle('process.signal', { signal, argv, ...(parent ? { parent } : {}), ms: Date.now() - startedAt });
      if (process.listenerCount(signal) > 1) return;
      process.removeListener(signal, onSignal);
      process.kill(process.pid, signal);
    };
    process.on(signal, onSignal);
  }
  // The monitor observes without handling: a listener on uncaughtException
  // itself would stop Node exiting on the error.
  process.on('uncaughtExceptionMonitor', (error, origin) => lifecycle('process.error', { origin, argv, ...(errnoOf(error) ? { errno: errnoOf(error) } : {}), message: redactForLog(error?.message ?? '').slice(0, 300) }));
}
