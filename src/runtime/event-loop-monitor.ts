/** The window's event loop, watched cheaply: one `event-loop.blocked` lifecycle line when it stalled for more than a tenth of a second,
 * at most one every ten seconds, with how long and how many stalls were left unlogged since. Counts and durations only. A freeze that
 * a user reports as "it hung for a second" leaves no other trace: nothing in the process knows it was not running. */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { lifecycle } from './lifecycle-log.js';

const BLOCKED_THRESHOLD_MS = 100;
const BLOCKED_LOG_GAP_MS = 10_000;
const SAMPLE_MS = 1_000;

/** Decides which stalls are written: over the threshold, and not within the gap of the last one written. The ones skipped are counted
 * into the next line. */
export function blockedLogger(
  write: (fields: { ms: number; suppressed: number }) => void, now: () => number = Date.now,
  thresholdMs = BLOCKED_THRESHOLD_MS, gapMs = BLOCKED_LOG_GAP_MS,
): (worstMs: number) => void {
  let lastWritten: number | undefined;
  let suppressed = 0;
  return (worstMs) => {
    if (worstMs <= thresholdMs) return;
    const at = now();
    if (lastWritten !== undefined && at - lastWritten < gapMs) { suppressed += 1; return; }
    lastWritten = at;
    const skipped = suppressed;
    suppressed = 0;
    write({ ms: Math.round(worstMs), suppressed: skipped });
  };
}

/** Start sampling (a 20 ms timer inside Node, histogram read once a second). Returns the stop function. */
export function startEventLoopMonitor(): () => void {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const note = blockedLogger(({ ms, suppressed }) => lifecycle('event-loop.blocked', { ms, ...(suppressed ? { suppressed } : {}) }));
  const timer = setInterval(() => {
    // The histogram's max is nanoseconds of delay beyond the 20 ms resolution.
    const worstMs = histogram.max / 1e6;
    histogram.reset();
    note(worstMs);
  }, SAMPLE_MS);
  timer.unref();
  return () => { clearInterval(timer); histogram.disable(); };
}
