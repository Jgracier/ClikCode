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
  /** Wheel reporting (`CSI ?1000h` + SGR), for reading the transcript back. */
  wheelReporting: boolean;
  /** Theme-change notifications (`CSI ?2031h`), set for the same reason. */
  /** The UI is drawing on the alternate screen and owes the shell its own back. */
  alternateScreen: boolean;
  rawMode: boolean;
  /** A frame hid the cursor / disabled autowrap / opened a synchronized update. */
  painted: boolean;
  /** A terminal UI took this terminal, so it owes the shell a full restore --
   * every mouse mode and the state a client latches, not only what a flag here
   * happened to record. A process that never drew writes nothing. */
  uiStarted: boolean;
  /** Supplied by the live prompter: erases its composer and footer so whatever
   * is printed next (a stack trace, the shell prompt) starts on a clean row. */
  leaveLiveRegion?: () => string;
} = { bracketedPaste: false, kittyKeyboard: false, wheelReporting: false, alternateScreen: false, rawMode: false, painted: false, uiStarted: false };

/** The main screen's state, cleared before this program takes the alternate
 * one -- because the previous session may never have got the chance.
 *
 * A teardown is written into the terminal on the way out, and on a phone the
 * usual way a session ends is the client hanging up first: the connection is
 * already gone, the pty is dead, and every byte of that teardown goes nowhere.
 * Measured exactly so -- ClikCode exits cleanly and the next run is fine, but
 * close the session from the client and the next run is broken again.
 *
 * So the same state is cleared on the way IN, where the terminal is
 * demonstrably alive. Whatever the last program left set, mouse reporting
 * included, is undone before this one asks for anything. Clearing a mode that
 * is already clear costs nothing. */
export function terminalPrepare(): string {
  return '\x1b[?1006l\x1b[?1016l\x1b[?1003l\x1b[?1002l\x1b[?1000l'
    + '\x1b[?2004l\x1b[?2031l\x1b[?1004l'
    + '\x1b[>4m\x1b(B\x0f\x1b7\x1b[r\x1b8';
}

/** Everything a client may hold, cleared on BOTH screens.
 *
 * Transcribed from Claude Code's exit, and the order is the point: it clears
 * the mouse modes on the alternate screen, leaves it, then clears them again
 * on the main screen. Emulators commonly keep DEC private modes per screen
 * buffer, so clearing only the alternate screen leaves the main screen dirty --
 * and the next session's `?1049h` inherits it.
 *
 * `?1016` and modifyOtherKeys are cleared although this never sets them, for
 * the same reason Claude Code does: whatever ran before may have. */
export function terminalTeardown(leavingAlternateScreen: boolean): string {
  const mouseOff = '\x1b[?1006l\x1b[?1016l\x1b[?1003l\x1b[?1002l\x1b[?1000l';
  const readsOff = '\x1b[?2004l\x1b[?2031l\x1b[?1004l';
  const latchedOff = '\x1b[>4m\x1b(B\x0f\x1b7\x1b[r\x1b8';
  return `${mouseOff}${readsOff}${leavingAlternateScreen ? '\x1b[?1049l' : ''}`
    + `${mouseOff}${readsOff}${latchedOff}\x1b[?7h\x1b[?25h`;
}

/** Leave the terminal the way a shell expects it: synchronized update closed,
 * kitty keyboard flags popped, bracketed paste off, autowrap on, cursor shown,
 * cooked mode. Idempotent, and never throws -- it runs inside crash handlers. */
export function restoreTerminal(options: { sync?: boolean } = {}): void {
  try {
    // Nothing was ever switched on, so there is nothing to put back -- and a
    // process that never drew must not write escape sequences into a shell it
    // was only ever piped through. This is also what keeps repeat calls silent.
    const touched = terminalModes.uiStarted || terminalModes.painted || terminalModes.kittyKeyboard
      || terminalModes.bracketedPaste || terminalModes.wheelReporting
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
    // Order transcribed from Claude Code's exit, captured from this user's
    // phone, and the order is the point.
    //
    // It clears the mouse modes on the ALTERNATE screen, then leaves it, then
    // clears them AGAIN on the main screen -- twice. This cleared them once,
    // on the alternate screen, and left `?1049l` for last, so the main screen's
    // mouse state was never touched at all.
    //
    // Emulators commonly keep DEC private modes per screen buffer. Leaving the
    // main screen dirty means the next session's `?1049h` inherits it, which is
    // the self-perpetuating failure actually observed: ClikCode stops scrolling
    // with the keyboard hidden and stays broken across restarts, and running
    // Claude Code once -- which does clean the main screen -- fixes the next
    // ClikCode.
    sequence += terminalTeardown(terminalModes.alternateScreen);
    const wasRaw = terminalModes.rawMode;
    terminalModes.uiStarted = false;
    terminalModes.painted = false;
    terminalModes.kittyKeyboard = false;
    terminalModes.bracketedPaste = false;
    terminalModes.wheelReporting = false;
    terminalModes.alternateScreen = false;
    terminalModes.rawMode = false;
    terminalModes.leaveLiveRegion = undefined;
    if (sequence && output.isTTY) {
      // From a signal handler the process dies immediately after this, and a
      // queued stream write is simply lost -- measured, a SIGTERM produced no
      // teardown at all. writeSync goes straight to the descriptor. Everywhere
      // else the stream is used, because that is what the rest of the UI (and
      // the test terminal) writes through.
      if (options.sync) {
        try { writeSync(output.fd, sequence); } catch { output.write(sequence); }
      } else output.write(sequence);
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
      restoreTerminal({ sync: true });
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    });
  }
}
