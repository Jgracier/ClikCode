/** Pacing text that arrives in a burst so it reads as it was written.
 *
 * Some models (Claude Sonnet and Opus after a tool call, measured 2026-10-26) hand over a whole
 * answer within tens of milliseconds, so it would appear at once. The words already here are shown
 * a share at a time: the backlog shrinks by a fixed fraction each moment, so a long answer starts
 * fast and eases out, and the whole of it is out within about a second and a half. A backlog of a
 * few words -- ordinary streaming -- is shown at once, so a model that streams is never slowed. */

/** A backlog this small is shown whole: it is what ordinary streaming leaves between two frames. */
export const REVEAL_IMMEDIATE_CHARS = 60;
/** The backlog shrinks by 1 - 1/e every this long. */
export const REVEAL_TIME_CONSTANT_MS = 350;
/** The longest the end of a turn waits for the reveal to catch up. */
export const REVEAL_MAX_HOLD_MS = 2500;
/** How often a reveal steps. */
export const REVEAL_FRAME_MS = 33;

/** How much of `total` characters to show now, `shown` having been shown `elapsedMs` ago. */
export function nextRevealed(shown: number, total: number, elapsedMs: number): number {
  const backlog = total - shown;
  if (backlog <= REVEAL_IMMEDIATE_CHARS) return total;
  const share = 1 - Math.exp(-Math.max(0, elapsedMs) / REVEAL_TIME_CONSTANT_MS);
  return Math.min(total, shown + Math.max(1, Math.ceil(backlog * share)));
}

/** `text` cut to `length` characters without splitting a surrogate pair. */
export function revealedPrefix(text: string, length: number): string {
  if (length >= text.length) return text;
  const code = text.charCodeAt(length - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? length - 1 : length);
}
