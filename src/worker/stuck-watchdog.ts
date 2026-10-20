/** Ends a worker whose own event loop has stopped turning.
 *
 * Everything that would end a worker -- the idle exit, the check that its home
 * is gone, SIGTERM's graceful shutdown -- runs on its event loop. A worker
 * stuck in a loop of its own therefore never ends: MEASURED 2026-10-12, a
 * VS Code test run's worker spun in HTTP/2 writes for 85 minutes after its
 * test ended, reached 22G, and held most of the agent slice the whole time.
 *
 * So the check runs on a thread of its own: the event loop bumps a shared
 * counter, and when the counter has not moved for STUCK_MS the worker cannot
 * answer any window or finish any turn. The thread logs it and kills the
 * process -- the worker deciding about itself; nothing else ever does. A
 * conversation the worker owed something finds it gone and starts a new one,
 * as after any crash. */
import { Worker } from 'node:worker_threads';
import { lifecycleLogPath } from '../runtime/lifecycle-log.js';

const BEAT_MS = 5_000;
export const STUCK_MS = 3 * 60_000;

/** The thread: plain JavaScript, run from this string, so it needs nothing from the bundle. */
export const WATCHDOG_THREAD = `
const { workerData } = require('node:worker_threads');
const { appendFileSync } = require('node:fs');
const beats = new Int32Array(workerData.beats);
let seen = Atomics.load(beats, 0);
let since = Date.now();
setInterval(() => {
  const now = Atomics.load(beats, 0);
  if (now !== seen) { seen = now; since = Date.now(); return; }
  if (Date.now() - since < workerData.stuckMs) return;
  try {
    appendFileSync(workerData.log, JSON.stringify({
      stuckForMs: Date.now() - since, t: new Date().toISOString(), pid: process.pid,
      role: 'worker', session: workerData.sessionId, event: 'worker.stuck',
    }) + '\\n');
  } catch {}
  process.kill(process.pid, 'SIGKILL');
}, workerData.checkMs);
`;

export function startStuckWatchdog(sessionId: string, options: { stuckMs?: number; beatMs?: number } = {}): (() => void) | undefined {
  const stuckMs = options.stuckMs ?? STUCK_MS;
  const beatMs = options.beatMs ?? BEAT_MS;
  const beats = new Int32Array(new SharedArrayBuffer(4));
  const beat = setInterval(() => { Atomics.add(beats, 0, 1); }, beatMs);
  beat.unref();
  let log = '';
  try { log = lifecycleLogPath(); } catch { /* fail-open-ok: no log to write; the kill still happens */ }
  const thread = new Worker(WATCHDOG_THREAD, {
    eval: true,
    workerData: { beats: beats.buffer, stuckMs, checkMs: Math.min(10_000, Math.max(50, Math.floor(stuckMs / 6))), log, sessionId },
    // The fixed watchdog script uses only a few MB, but Node/V8 needs more
    // headroom while creating its isolate. A tiny heap limit can abort the
    // entire session process before its socket is ready (SIGILL in OS::Abort).
    // The agent slice bounds the process; no user code runs in this thread.
    stdout: false, stderr: false,
  });
  thread.unref();
  thread.on('error', () => undefined);
  return () => { clearInterval(beat); void thread.terminate(); };
}
