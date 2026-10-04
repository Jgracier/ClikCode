/**
 * Every display timing shared by the terminal and the VS Code webview. Chalk
 * free and dependency free, so the webview bundle can import it.
 */

/** How often a spinner steps and a shimmer moves while work is arriving. */
export const SPIN_MS = 300;

/** Bursts of streamed output inside this window are painted once. */
export const PAINT_COALESCE_MS = 32;

/** How long a transient notice ("Copied", "Could not copy: …") stays up. */
export const NOTICE_MS = 4000;

/** A wait shorter than this shows nothing; past it a spinner or a "looking
 * for…" row appears. Most lookups answer in milliseconds, and a spinner that
 * starts and stops at once reads as a flash. */
export const SLOW_WAIT_MS = 400;
