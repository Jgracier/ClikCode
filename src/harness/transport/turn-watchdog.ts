/** The silence ceiling for a turn on a persistent transport (Codex
 * app-server, ACP). Same policy as a one-shot CLI turn (native/turn.ts): a
 * turn ends on the vendor's own completion event, and this is only the
 * safety net for a vendor that has gone quiet for good. Every message from
 * the vendor restarts the countdown; while a tool it started is still
 * running, the countdown is the (much longer) tool budget, because a build or
 * a test suite is legitimately silent for a long time. While the user is
 * deciding an approval the vendor is waiting on us, so the clock is paused. */

/** A turn whose vendor has said nothing at all for this long is wedged. */
export const PERSISTENT_TURN_IDLE_MS = 10 * 60 * 1000;
/** A silent tool is given this long. */
export const PERSISTENT_TOOL_IDLE_MS = 60 * 60 * 1000;

export interface TurnWatchdogOptions {
  /** Ordinary silence budget. Default: CLIKCODE_TURN_IDLE_TIMEOUT_MS, else
   * PERSISTENT_TURN_IDLE_MS. Zero or negative disables the watchdog. */
  idleMs?: number;
  /** Budget while a tool is running; never shortens `idleMs`. */
  toolIdleMs?: number;
  /** Called once, with the budget that ran out. */
  onIdle: (afterMs: number) => void;
}

export interface TurnWatchdog {
  /** Any sign of life from the vendor. */
  activity(): void;
  toolStarted(id: string): void;
  toolFinished(id: string): void;
  readonly runningTools: number;
  /** Stop counting until the returned function is called (an approval the
   * user has not answered yet). Nested pauses are counted. */
  pause(): () => void;
  stop(): void;
}

/** The silence budget in force: CLIKCODE_TURN_IDLE_TIMEOUT_MS, else
 * PERSISTENT_TURN_IDLE_MS. Also how long an agent may take to start: a
 * request that waits on the agent's own startup is bounded by this, not by
 * the adapter handshake's few seconds. */
export function configuredIdleMs(environment: NodeJS.ProcessEnv = process.env): number {
  const raw = environment.CLIKCODE_TURN_IDLE_TIMEOUT_MS;
  const configured = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(configured) ? configured : PERSISTENT_TURN_IDLE_MS;
}

export function createTurnWatchdog(options: TurnWatchdogOptions): TurnWatchdog {
  const idleMs = options.idleMs ?? configuredIdleMs();
  const toolIdleMs = options.toolIdleMs ?? PERSISTENT_TOOL_IDLE_MS;
  const running = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let paused = 0;
  let stopped = false;
  const arm = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (stopped || paused > 0 || idleMs <= 0) return;
    const budget = running.size > 0 ? Math.max(idleMs, toolIdleMs) : idleMs;
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped) return;
      stopped = true;
      options.onIdle(budget);
    }, budget);
    timer.unref?.();
  };
  arm();
  return {
    activity: arm,
    toolStarted: (id) => { running.add(id); arm(); },
    toolFinished: (id) => { running.delete(id); arm(); },
    get runningTools() { return running.size; },
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
