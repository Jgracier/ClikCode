/** Optional silence ceiling for a turn, on every transport: the persistent
 * ones (Codex app-server, ACP) and a one-shot CLI turn (native/turn.ts).
 * Off unless CLIKCODE_TURN_IDLE_TIMEOUT_MS is set. A harness already stops
 * itself, and a quiet stretch is often a long command or a background agent.
 * A turn ends on the vendor's own completion event. When the clock is on,
 * every message from the vendor restarts it; while a tool it started is
 * still running, the countdown is the (much longer) tool budget. While the
 * user is deciding an approval the vendor is waiting on us, so the clock
 * is paused. */

/** A silent tool is given this long, and only when the silence clock is on. */
const PERSISTENT_TOOL_IDLE_MS = 60 * 60 * 1000;

export interface TurnWatchdogOptions {
  /** Ordinary silence budget. Default: configuredIdleMs(), which is off.
   * Zero or negative disables the watchdog. */
  idleMs?: number;
  /** Budget while a tool is running; never shortens `idleMs`. */
  toolIdleMs?: number;
  /** Called once, with the budget that ran out. */
  onIdle: (afterMs: number) => void;
}

export interface TurnWatchdog {
  /** Any sign of life from the vendor. */
  activity(): void;
  /** A tool began; while any is running the tool budget applies. A CLI
   * stream may give no id. */
  toolStarted(id?: string): void;
  /** A tool finished or failed. One whose start was never seen (or that
   * carries no id) still settles one id-less start, so the long budget is
   * not left armed by a vendor that names only one end of the pair. */
  toolFinished(id?: string): void;
  readonly runningTools: number;
  /** Stop counting until the returned function is called (an approval the
   * user has not answered yet). Nested pauses are counted. */
  pause(): () => void;
  stop(): void;
}

/** The silence budget in force. Unset means none: the harness runs until it
 * finishes, fails, or the user stops it. CLIKCODE_TURN_IDLE_TIMEOUT_MS, when
 * set to a positive number, is how long a vendor may stay silent before the
 * turn is stopped, and how long a control request may wait on an agent that
 * is still starting. Zero or negative leaves the clock off. */
export function configuredIdleMs(environment: NodeJS.ProcessEnv = process.env): number {
  const raw = environment.CLIKCODE_TURN_IDLE_TIMEOUT_MS;
  if (raw === undefined || raw === '') return 0;
  const configured = Number(raw);
  return Number.isFinite(configured) ? configured : 0;
}

export function createTurnWatchdog(options: TurnWatchdogOptions): TurnWatchdog {
  const idleMs = options.idleMs ?? configuredIdleMs();
  const toolIdleMs = options.toolIdleMs ?? PERSISTENT_TOOL_IDLE_MS;
  const running = new Set<string>();
  let anonymous = 0;
  let timer: NodeJS.Timeout | undefined;
  let paused = 0;
  let stopped = false;
  /** Bumped by every arm: a countdown that fires after a later arm is stale. */
  let armed = 0;
  const arm = (): void => {
    armed += 1;
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (stopped || paused > 0 || idleMs <= 0) return;
    const budget = running.size + anonymous > 0 ? Math.max(idleMs, toolIdleMs) : idleMs;
    const mine = armed;
    timer = setTimeout(() => {
      timer = undefined;
      // A process that was not scheduled for a while (a loaded machine, a
      // laptop waking) runs its expired timers BEFORE reading the input that
      // arrived meanwhile -- the vendor's messages were there in time, and
      // the turn was failed as silent anyway. Decide only after this turn of
      // the event loop has read what is waiting (setImmediate runs after the
      // poll phase); any of it re-arms the countdown.
      setImmediate(() => {
        if (stopped || armed !== mine) return;
        stopped = true;
        options.onIdle(budget);
      });
    }, budget);
    timer.unref?.();
  };
  arm();
  return {
    activity: arm,
    toolStarted: (id) => {
      if (id) running.add(id);
      else anonymous += 1;
      arm();
    },
    toolFinished: (id) => {
      if (id && running.delete(id)) { /* paired */ } else if (anonymous > 0) anonymous -= 1;
      else if (!id && running.size > 0) running.delete(running.values().next().value as string);
      arm();
    },
    get runningTools() { return running.size + anonymous; },
    pause: () => {
      paused += 1;
      arm();
      let resumed = false;
      return () => {
        if (resumed) return;
        resumed = true;
        paused -= 1;
        arm();
      };
    },
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** The error a turn fails with when the watchdog fires. `reason` matches the
 * one-shot CLI path's NativeHarnessTurnError. */
export function turnIdleError(label: string, afterMs: number): Error {
  return Object.assign(
    new Error(`${label} produced no output for ${Math.round(afterMs / 1000)}s and was stopped`),
    { reason: 'idle-timeout' as const },
  );
}
