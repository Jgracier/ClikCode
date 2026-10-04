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
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stateDirectory } from '../session/store/paths.js';

export type LifecycleRole = 'window' | 'worker' | 'bridge' | 'command';

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

export function lifecycleLogPath(): string {
  return join(stateDirectory(), 'logs', 'lifecycle.log');
}

function enabled(): boolean {
  // The suite drives many processes against throwaway homes; a test that
  // wants the log sets CLIKCODE_LIFECYCLE_LOG.
  return !process.env.VITEST || process.env.CLIKCODE_LIFECYCLE_LOG === '1';
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
    const line = JSON.stringify({ ...fields, t: new Date().toISOString(), pid: process.pid, role, ...(session ? { session } : {}), event });
    appendFileSync(path, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch { /* fail-open-ok: logging must never break what it records */ }
}

let exitHooked = false;

/** Log this process's start, and its end: an exit with its code, and an
 * uncaught error with its message (crash.log keeps the stack). */
export function lifecycleProcess(details: Readonly<Record<string, unknown>> = {}): void {
  lifecycle('process.start', { argv: process.argv.slice(2, 4).join(' '), node: process.version, ...details });
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', (code) => lifecycle('process.exit', { code }));
  // The monitor observes without handling: a listener on uncaughtException
  // itself would stop Node exiting on the error.
  process.on('uncaughtExceptionMonitor', (error, origin) => lifecycle('process.error', { origin, message: error?.message?.slice(0, 300) }));
}
