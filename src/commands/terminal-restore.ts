/** Terminal mode bookkeeping with no dependencies, so the process-level crash
 * handlers can import it without loading the whole terminal UI.
 *
 * Every mode the UI switches on is recorded here at the moment it is switched
 * on. restoreTerminal() undoes exactly those, which is what makes it safe to
 * call from anywhere, any number of times, including when no UI ever started. */

import { writeSync } from 'node:fs';
import { stdin as input, stdout as output } from 'node:process';

export const terminalModes: {
  bracketedPaste: boolean;
  kittyKeyboard: boolean;
  /** Focus reporting (`CSI ?1004h`): what an interactive application sets, and
   * what a client reads to tell one from a shell. */
  focusReporting: boolean;
  /** Wheel reporting (`CSI ?1000h` + SGR), for reading the transcript back. */
  wheelReporting: boolean;
  /** Theme-change notifications (`CSI ?2031h`), set for the same reason. */
  themeNotifications: boolean;
  /** The UI is drawing on the alternate screen and owes the shell its own back. */
  alternateScreen: boolean;
  rawMode: boolean;
  /** A frame hid the cursor / disabled autowrap / opened a synchronized update. */
  painted: boolean;
  /** Supplied by the live prompter: erases its composer and footer so whatever
   * is printed next (a stack trace, the shell prompt) starts on a clean row. */
  leaveLiveRegion?: () => string;
} = { bracketedPaste: false, kittyKeyboard: false, focusReporting: false, wheelReporting: false, themeNotifications: false, alternateScreen: false, rawMode: false, painted: false };

/** Leave the terminal the way a shell expects it: synchronized update closed,
 * kitty keyboard flags popped, bracketed paste off, autowrap on, cursor shown,
 * cooked mode. Idempotent, and never throws -- it runs inside crash handlers. */
export function restoreTerminal(): void {
  try {
    // Nothing was ever switched on, so there is nothing to put back -- and a
    // process that never drew must not write escape sequences into a shell it
    // was only ever piped through. This is also what keeps repeat calls silent.
    const touched = terminalModes.painted || terminalModes.kittyKeyboard || terminalModes.bracketedPaste
      || terminalModes.themeNotifications || terminalModes.wheelReporting || terminalModes.focusReporting
      || terminalModes.alternateScreen || terminalModes.rawMode;
    if (!touched) {
      if (input.isRaw && input.isTTY && typeof input.setRawMode === 'function') input.setRawMode(false);
      return;
    }
    let sequence = '';
    if (terminalModes.painted) sequence += `\x1b[?2026l${terminalModes.leaveLiveRegion?.() ?? ''}`;
    if (terminalModes.kittyKeyboard) sequence += '\x1b[<u';
    // Unconditional from here, and deliberately more than was switched on.
    //
    // This used to undo only what it had recorded, and it recorded wheel
    // reporting as a single flag while switching on four modes -- so a session
    // that ended by kill, crash or dropped connection left `?1002h` and
    // `?1003h` set in the client. The next session then opened into a terminal
    // that still believed the last application owned the mouse.
    //
    // Claude Code's own exit, captured from this user's phone, clears modes it
    // never sets: `?1016l`, `CSI > 4 m`, the charset, the scroll region, each
    // of the four mouse modes, twice over. That is what a program does when it
    // knows a client latches state, and it is why running Claude Code once
    // makes the next program work -- measured here three times.
    sequence += '\x1b[?1006l\x1b[?1016l\x1b[?1003l\x1b[?1002l\x1b[?1000l';
    sequence += '\x1b[?2004l\x1b[?2031l\x1b[?1004l';
    sequence += '\x1b[>4m';          // modifyOtherKeys back to the default
    sequence += '\x1b(B\x0f';        // US-ASCII into G0, shift in
    sequence += '\x1b7\x1b[r\x1b8';   // release any scroll region, moving nothing
    sequence += '\x1b[?7h\x1b[?25h';
    // Last, so everything above lands on the screen it was meant for.
    if (terminalModes.alternateScreen) sequence += '\x1b[?1049l';
    const wasRaw = terminalModes.rawMode;
    terminalModes.painted = false;
    terminalModes.kittyKeyboard = false;
    terminalModes.bracketedPaste = false;
    terminalModes.focusReporting = false;
    terminalModes.wheelReporting = false;
    terminalModes.themeNotifications = false;
    terminalModes.alternateScreen = false;
    terminalModes.rawMode = false;
    terminalModes.leaveLiveRegion = undefined;
    if (sequence && output.isTTY) {
      // writeSync, not output.write: this runs from signal handlers that
      // re-raise immediately, and a queued stream write is simply lost when
      // the process dies. Measured -- a SIGTERM produced no teardown at all,
      // not one sequence, with the handler installed and running.
      try { writeSync(output.fd, sequence); } catch { output.write(sequence); }
    }
    // `isRaw` covers reads (pickers) that entered raw mode without recording it.
    if ((wasRaw || input.isRaw) && input.isTTY && typeof input.setRawMode === 'function') input.setRawMode(false);
  } catch {
    // fail-open-ok: a closed or broken TTY cannot be restored, and a crash handler must still report the crash.
  }
}

/** The signals that end an SSH session, wired to put the terminal back.
 *
 * `process.on('exit')` alone is not enough: a default-handled SIGTERM or
 * SIGHUP kills the process without ever running it, so a session ended by
 * closing the client, dropping the connection, or `kill` left every mode it
 * had switched on still set -- measured: a SIGTERM produced no teardown
 * whatsoever, not one sequence. The next session then opened into a terminal
 * that still believed the last application owned the mouse, and a swipe with
 * the keyboard hidden reached nothing.
 *
 * Registered once, and re-raised after restoring so the process still dies of
 * the signal it was sent rather than silently swallowing it. */
const RESTORE_SIGNALS = ['SIGHUP', 'SIGTERM', 'SIGQUIT'] as const;
let restoreSignalsInstalled = false;
export function installTerminalRestoreSignals(): void {
  if (restoreSignalsInstalled) return;
  restoreSignalsInstalled = true;
  for (const signal of RESTORE_SIGNALS) {
    process.on(signal, () => {
      restoreTerminal();
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    });
  }
}
