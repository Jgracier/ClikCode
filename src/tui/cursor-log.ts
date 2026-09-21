/** A short, bounded record of what the terminal actually did, written to
 * ~/.clikcode/cursor.log. Placing the cursor depends on how a client answers
 * (or ignores) DSR, which cannot be seen from a screenshot and differs per
 * terminal; this is how a report becomes a diagnosis. */

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A short, bounded record of what the terminal actually did with the cursor,
 * written to ~/.clikcode/cursor.log. Placing the cursor depends on how a
 * client answers (or ignores) DSR, which cannot be seen from a screenshot and
 * differs per terminal; this is how a report becomes a diagnosis. Sixty lines
 * per process, so a long session cannot grow it without bound. */
let cursorLogLines = 0;

let inputLogLines = 0;

/** Frames are noisy and a session opens with a burst of them; what a client
 * sends is rare and is the thing a report turns on. One budget each, so a
 * startup cannot spend the budget that would have recorded the swipe. */
const FRAME_LOG_LINES = 60;

const INPUT_LOG_LINES = 2_000;

export function logCursorEvent(line: string): void {
  // VITEST: the suite drives a stubbed terminal against the real home
  // directory, and these lines per test process are noise that buries the one
  // session anybody wants to read.
  if (process.env.VITEST) return;
  // Resizes belong to the input budget: they are the event the scrolling
  // reports turn on, and the frame budget is spent within a second of startup.
  const isInput = line.startsWith('input ') || line.startsWith('scroll ') || line.startsWith('resize ');
  if (isInput) {
    if (inputLogLines >= INPUT_LOG_LINES) return;
    inputLogLines += 1;
  } else {
    if (cursorLogLines >= FRAME_LOG_LINES) return;
    cursorLogLines += 1;
  }
  try {
    const dir = join(homedir(), '.clikcode');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'cursor.log'), `[${new Date().toISOString()}] pid ${process.pid} ${line}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch { /* fail-open-ok: diagnostics must never break the UI */ }
}
