/**
 * Installing a vendor CLI without putting npm's progress on the screen.
 *
 * `npm install --global` inherited the terminal, so choosing a provider that
 * was not installed yet dumped npm's whole log -- progress bars, deprecation
 * warnings, funding notices, an audit summary -- into the middle of the UI.
 * None of it is the user's decision to make, and on a phone it is several
 * screens of it.
 *
 * The output is captured instead: one animated line while it runs, one line
 * when it finishes. A failure is the exception -- then the tail is printed,
 * because an install that did not work is exactly when the log matters.
 */

import { waitingSpinnerGlyph } from './protocol/activity-view.js';
import { SPIN_MS } from './protocol/timings.js';
import { reducedMotion } from '../tui/capabilities.js';
/** Enough of npm's log to explain a failure, not enough to be another dump. */
const FAILURE_TAIL_LINES = 12;

export function installFailureTail(output: string, limit = FAILURE_TAIL_LINES): string {
  const lines = output.split(/\r?\n/)
    // npm's funding/audit footer says nothing about why an install failed.
    .filter((line) => line.trim() && !/^\s*(?:npm (?:notice|fund|warn deprecated)|\d+ packages are looking for funding|run `npm fund`)/i.test(line));
  return lines.slice(-limit).join('\n');
}

interface Spinner { stop: (finalLine?: string) => void }

/** One self-clearing line. Silent where stdout is not a terminal, so piped
 * and CI output stays clean rather than filling with frames. The waiting
 * band's spinner -- its glyphs, its SPIN_MS step -- and, under reduced
 * motion, held on one frame. */
export function startSpinner(
  label: string, write: (text: string) => void = (text) => process.stdout.write(text), isTty = process.stdout.isTTY,
  still = reducedMotion(),
): Spinner {
  if (!isTty) {
    write(`${label}\n`);
    return { stop: (finalLine) => { if (finalLine) write(`${finalLine}\n`); } };
  }
  let frame = 0;
  const paint = (): void => {
    write(`\r\u001b[2K\u001b[2m${waitingSpinnerGlyph(frame)}\u001b[0m  ${label}`);
    frame += 1;
  };
  paint();
  const timer = still ? undefined : setInterval(paint, SPIN_MS);
  timer?.unref?.();
  return {
    stop: (finalLine) => {
      if (timer) clearInterval(timer);
      write(`\r\u001b[2K${finalLine ? `${finalLine}\n` : ''}`);
    },
  };
}
