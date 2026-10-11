/**
 * Every display timing shared by the terminal and the VS Code webview. Chalk
 * free and dependency free, so the webview bundle can import it.
 */

/** How often a spinner steps and a shimmer moves while work is arriving.
 * Claude Code steps its glyph at 50-100 ms and Codex similarly; at 300 ms
 * the same glyph read as steppy beside them. At most 120 (a test holds it).
 * Painting stays cheap: ticks go through the 32 ms paint coalesce and the
 * frame writes only the rows that changed, in one synchronized update. */
export const SPIN_MS = 100;

/** The spinner's phases: one full turn of it is SPIN_PHASES * SPIN_MS, which
 * is also how long one pulse of a working dot takes. */
export const SPIN_PHASES = 4;

/** The shimmer's highlight moves this many characters per spinner step: one
 * cell a step, a sweep of ~200 ms/char at most as Claude Code's. */
export const SHIMMER_STRIDE = 1;

/** How wide the shimmer's highlight is, in characters either side. */
export const SHIMMER_WIDTH = 4;

/** One sweep of the shimmer over a label this many characters long. */
export function shimmerCycleMs(length: number): number {
  return Math.ceil((length + SHIMMER_WIDTH * 2) / SHIMMER_STRIDE) * SPIN_MS;
}

/** Bursts of streamed output inside this window are painted once. */
export const PAINT_COALESCE_MS = 32;

/** How long a transient notice ("Could not copy: …", a VS Code error toast)
 * stays up. */
export const NOTICE_MS = 4000;

/** How long a copy button shows its tick after copying. */
export const COPIED_MS = 1200;

/** @deprecated Writing no longer expires: see answerWriting() in
 * turn-flow.ts. Kept only so the webview still compiles until it uses that. */
export const WRITING_MS = 1500;

/** A wait shorter than this shows nothing; past it a spinner or a "looking
 * for…" row appears. Most lookups answer in milliseconds, and a spinner that
 * starts and stops at once reads as a flash. */
export const SLOW_WAIT_MS = 400;

/** A slow wait's spinner or row, once shown, stays at least this long: one
 * that appeared and went in a frame or two read as a flash. */
export const MIN_VISIBLE_MS = 300;
