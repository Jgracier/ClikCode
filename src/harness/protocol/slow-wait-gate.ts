/** A wait appears only when slow and ends with its work. */

import { SLOW_WAIT_MS } from './timings.js';

interface SlowWaitGate {
  /** Resolves when the wait is shown; never, for work that ended first. */
  readonly shown: Promise<void>;
  /** Take down the wait immediately when its work is over. */
  end(): Promise<void>;
}

export function slowWaitGate(show: () => void, hide: () => void): SlowWaitGate {
  let shownAt: number | undefined;
  let ending: Promise<void> | undefined;
  let markShown!: () => void;
  const shown = new Promise<void>((resolve) => { markShown = resolve; });
  const timer = setTimeout(() => {
    if (ending) return;
    shownAt = Date.now();
    show();
    markShown();
  }, SLOW_WAIT_MS);
  (timer as { unref?: () => void }).unref?.();
  return {
    shown,
    end: () => ending ??= (async () => {
      clearTimeout(timer);
      if (shownAt === undefined) return;
      hide();
    })(),
  };
}
