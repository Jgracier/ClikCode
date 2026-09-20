/** Terminal mode bookkeeping with no dependencies, so the process-level crash
 * handlers can import it without loading the whole terminal UI.
 *
 * Every mode the UI switches on is recorded here at the moment it is switched
 * on. restoreTerminal() undoes exactly those, which is what makes it safe to
 * call from anywhere, any number of times, including when no UI ever started. */

import { stdin as input, stdout as output } from 'node:process';

export const terminalModes: {
  bracketedPaste: boolean;
  kittyKeyboard: boolean;
  /** DECCKM: arrow keys arrive as SS3 while an application owns the terminal. */
  applicationCursorKeys: boolean;
  rawMode: boolean;
  /** A frame hid the cursor / disabled autowrap / opened a synchronized update. */
  painted: boolean;
  /** Supplied by the live prompter: erases its composer and footer so whatever
   * is printed next (a stack trace, the shell prompt) starts on a clean row. */
  leaveLiveRegion?: () => string;
} = { bracketedPaste: false, kittyKeyboard: false, applicationCursorKeys: false, rawMode: false, painted: false };

/** Leave the terminal the way a shell expects it: synchronized update closed,
 * kitty keyboard flags popped, bracketed paste off, autowrap on, cursor shown,
 * cooked mode. Idempotent, and never throws -- it runs inside crash handlers. */
export function restoreTerminal(): void {
  try {
    let sequence = '';
    if (terminalModes.painted) sequence += `\x1b[?2026l${terminalModes.leaveLiveRegion?.() ?? ''}`;
    if (terminalModes.kittyKeyboard) sequence += '\x1b[<u';
    if (terminalModes.bracketedPaste) sequence += '\x1b[?2004l';
    if (terminalModes.applicationCursorKeys) sequence += '\x1b[?1l';
    if (terminalModes.painted) sequence += '\x1b[?7h\x1b[?25h';
    const wasRaw = terminalModes.rawMode;
    terminalModes.painted = false;
    terminalModes.kittyKeyboard = false;
    terminalModes.bracketedPaste = false;
    terminalModes.applicationCursorKeys = false;
    terminalModes.rawMode = false;
    terminalModes.leaveLiveRegion = undefined;
    if (sequence && output.isTTY) output.write(sequence);
    // `isRaw` covers reads (pickers) that entered raw mode without recording it.
    if ((wasRaw || input.isRaw) && input.isTTY && typeof input.setRawMode === 'function') input.setRawMode(false);
  } catch {
    // fail-open-ok: a closed or broken TTY cannot be restored, and a crash handler must still report the crash.
  }
}
