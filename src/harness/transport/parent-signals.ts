/** Passing ClikCode's own SIGINT/SIGTERM/SIGHUP on to the vendor processes
 * it runs, from one place.
 *
 * Each spawner used to add its own `process.once('SIGTERM', ...)`. Any
 * listener turns off Node's default for that signal, which is to exit: a
 * SIGTERM during a sign-in stopped the vendor and left ClikCode running.
 * Here the children are stopped and then, for SIGTERM and SIGHUP, the signal
 * is raised again with no listener of ours left, so ClikCode ends as it would
 * have -- unless the process installed its own handler (a worker's orderly
 * shutdown), which then decides. SIGINT is Ctrl+C: it stops the vendor's
 * work, and what follows is the caller's to say. */

type ParentSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';

type Stop = (signal: ParentSignal) => void;

/** Each stop and the signals it is for. */
const stops = new Map<Stop, ReadonlySet<ParentSignal>>();
const handlers = new Map<ParentSignal, () => void>();

const ALL: readonly ParentSignal[] = process.platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** A handler for exactly the signals some stop is for. */
function sync(): void {
  const wanted = new Set<ParentSignal>();
  for (const signals of stops.values()) for (const signal of signals) wanted.add(signal);
  for (const [signal, handler] of [...handlers]) {
    if (wanted.has(signal)) continue;
    process.off(signal, handler);
    handlers.delete(signal);
  }
  for (const signal of wanted) {
    if (handlers.has(signal)) continue;
    const handler = (): void => received(signal);
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
}

function received(signal: ParentSignal): void {
  for (const [stop, signals] of [...stops]) {
    if (!signals.has(signal)) continue;
    stops.delete(stop);
    try { stop(signal); } catch { /* fail-open-ok: one child's stop must not keep the others running */ }
  }
  sync();
  if (signal === 'SIGINT') return;
  // Ours were the only listeners: do what Node would have done.
  const handler = handlers.get(signal);
  if (handler) { process.off(signal, handler); handlers.delete(signal); }
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

/** Calls `stop` with the signal when ClikCode receives one of `signals`
 * (all three by default), once. Returns the release, for when the child has
 * ended on its own. */
export function forwardParentSignals(stop: Stop, signals: readonly ParentSignal[] = ALL): () => void {
  stops.set(stop, new Set(signals.filter((signal) => ALL.includes(signal))));
  sync();
  return () => {
    stops.delete(stop);
    sync();
  };
}
