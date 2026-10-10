/** The page's one clock: every spinner steps on the same frame and every
 * running timer reads the same second, from one interval each, and neither
 * runs while the panel is hidden (the webviews are retained when hidden, so
 * their timers would otherwise keep firing). Under reduced motion the frame
 * stands still; that preference is followed live. */

import { useEffect, useState } from 'preact/hooks';
import { SPIN_MS, SPIN_PHASES } from '../../../../src/harness/protocol/timings';
import { listen } from './bus';

type Ticker = { ms: number; listeners: Set<() => void>; timer?: ReturnType<typeof setInterval>; count: number };

const spin: Ticker = { ms: SPIN_MS, listeners: new Set(), count: 0 };
const second: Ticker = { ms: 1000, listeners: new Set(), count: 0 };

const motion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined;
/** Hidden by the host (the view was closed or covered: a retained page keeps
 * running) or by the browser (the window minimised). */
let viewHidden = false;
const hidden = (): boolean => viewHidden || (typeof document !== 'undefined' && document.visibilityState === 'hidden');

function sync(ticker: Ticker): void {
  const run = ticker.listeners.size > 0 && !hidden() && !(ticker === spin && motion?.matches);
  if (run && !ticker.timer) {
    ticker.timer = setInterval(() => {
      ticker.count += 1;
      for (const listener of ticker.listeners) listener();
    }, ticker.ms);
  } else if (!run && ticker.timer) {
    clearInterval(ticker.timer);
    ticker.timer = undefined;
  }
}

function resync(): void {
  sync(spin);
  sync(second);
  // Back in view: catch up at once rather than show a stale second.
  if (!hidden()) for (const listener of second.listeners) listener();
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', resync);
  // CSS animations keep the terminal's rhythm: a pulse is one turn of the spinner.
  document.documentElement?.style.setProperty('--spin-cycle', `${SPIN_MS * SPIN_PHASES}ms`);
}
motion?.addEventListener?.('change', resync);

/** The host showed or hid the view. */
export function setViewVisible(visible: boolean): void {
  viewHidden = !visible;
  resync();
}
listen((message) => { if (message.type === 'visible') setViewVisible(message.visible); });

/** Called on each step of the shared spinner or second; returns the
 * unsubscribe. The interval runs only while something listens. */
export function onTick(kind: 'spin' | 'second', listener: () => void): () => void {
  const ticker = kind === 'spin' ? spin : second;
  ticker.listeners.add(listener);
  sync(ticker);
  return () => {
    ticker.listeners.delete(listener);
    sync(ticker);
  };
}

function useTicker(kind: 'spin' | 'second', active: boolean): void {
  const [, rerender] = useState(0);
  useEffect(() => (active ? onTick(kind, () => rerender((value) => value + 1)) : undefined), [active]);
}

/** The shared spinner frame, stepping every SPIN_MS while `active`. */
export function useSpinFrame(active = true): number {
  useTicker('spin', active);
  return spin.count;
}

/** The time, refreshed once a second while mounted and `active`. */
export function useNow(active = true): number {
  useTicker('second', active);
  return Date.now();
}
