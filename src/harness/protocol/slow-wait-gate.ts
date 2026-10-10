/** When a wait is seen: only once it has taken SLOW_WAIT_MS, and once seen,
 * for MIN_VISIBLE_MS at least -- the one rule for the terminal's band and
 * rows and the editor's loading lines. Chalk free and dependency free, so
 * the webview bundle can import it. */

import { MIN_VISIBLE_MS, SLOW_WAIT_MS } from './timings.js';

export interface SlowWaitGate {
  /** Resolves when the wait is shown; never, for work that ended first. */
  readonly shown: Promise<void>;
  /** The work is over. Resolves once what was shown has been taken down --
   * at once if nothing was, else no sooner than MIN_VISIBLE_MS after it
   * appeared. */
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
      const left = shownAt + MIN_VISIBLE_MS - Date.now();
      if (left > 0) await new Promise<void>((resolve) => { setTimeout(resolve, left); });
      hide();
    })(),
  };
}
