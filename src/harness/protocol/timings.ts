/**
 * Every display timing shared by the terminal and the VS Code webview. Chalk
 * free and dependency free, so the webview bundle can import it.
 */

/** How often a spinner steps and a shimmer moves while work is arriving. */
export const SPIN_MS = 300;

/** The spinner's phases: one full turn of it is SPIN_PHASES * SPIN_MS, which
 * is also how long one pulse of a working dot takes. */
export const SPIN_PHASES = 4;

/** The shimmer's highlight moves this many characters per spinner step: at
 * SPIN_MS a step, one would take most of ten seconds to cross a short label. */
export const SHIMMER_STRIDE = 2;

/** How wide the shimmer's highlight is, in characters either side. */
export const SHIMMER_WIDTH = 4;

/** One sweep of the shimmer over a label this many characters long. */
export function shimmerCycleMs(length: number): number {
  return Math.ceil((length + SHIMMER_WIDTH * 2) / SHIMMER_STRIDE) * SPIN_MS;
}

/** Bursts of streamed output inside this window are painted once. */
export const PAINT_COALESCE_MS = 32;

/** How long a transient notice ("Copied", "Could not copy: …") stays up. */
export const NOTICE_MS = 4000;

/** A wait shorter than this shows nothing; past it a spinner or a "looking
 * for…" row appears. Most lookups answer in milliseconds, and a spinner that
 * starts and stops at once reads as a flash. */
export const SLOW_WAIT_MS = 400;
