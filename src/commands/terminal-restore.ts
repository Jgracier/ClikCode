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
  /** Focus reporting (`CSI ?1004h`): what an interactive application sets, and
   * what a client reads to tell one from a shell. */
  focusReporting: boolean;
  /** Theme-change notifications (`CSI ?2031h`), set for the same reason. */
  themeNotifications: boolean;
  rawMode: boolean;
  /** A frame hid the cursor / disabled autowrap / opened a synchronized update. */
  painted: boolean;
  /** Supplied by the live prompter: erases its composer and footer so whatever
   * is printed next (a stack trace, the shell prompt) starts on a clean row. */
  leaveLiveRegion?: () => string;
} = { bracketedPaste: false, kittyKeyboard: false, focusReporting: false, themeNotifications: false, rawMode: false, painted: false };

/** Leave the terminal the way a shell expects it: synchronized update closed,
 * kitty keyboard flags popped, bracketed paste off, autowrap on, cursor shown,
 * cooked mode. Idempotent, and never throws -- it runs inside crash handlers. */
export function restoreTerminal(): void {
  try {
    let sequence = '';
    if (terminalModes.painted) sequence += `\x1b[?2026l${terminalModes.leaveLiveRegion?.() ?? ''}`;
    if (terminalModes.kittyKeyboard) sequence += '\x1b[<u';
    if (terminalModes.bracketedPaste) sequence += '\x1b[?2004l';
    if (terminalModes.themeNotifications) sequence += '\x1b[?2031l';
    if (terminalModes.focusReporting) sequence += '\x1b[?1004l';
    if (terminalModes.painted) sequence += '\x1b[?7h\x1b[?25h';
    const wasRaw = terminalModes.rawMode;
    terminalModes.painted = false;
    terminalModes.kittyKeyboard = false;
    terminalModes.bracketedPaste = false;
    terminalModes.focusReporting = false;
    terminalModes.themeNotifications = false;
    terminalModes.rawMode = false;
    terminalModes.leaveLiveRegion = undefined;
    if (sequence && output.isTTY) output.write(sequence);
    // `isRaw` covers reads (pickers) that entered raw mode without recording it.
    if ((wasRaw || input.isRaw) && input.isTTY && typeof input.setRawMode === 'function') input.setRawMode(false);
  } catch {
    // fail-open-ok: a closed or broken TTY cannot be restored, and a crash handler must still report the crash.
  }
}
