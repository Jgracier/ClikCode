/** The terminal's mode vocabulary: the escape sequences ClikCode sets, the
 * raw-mode flag they depend on, and selection mode. */

import { kittyKeyboardSafe, POP_KITTY_KEYBOARD, PUSH_KITTY_KEYBOARD } from './keys.js';
import { stdin as input, stdout as output } from 'node:process';
import { terminalModes } from './restore.js';
import { logCursorEvent } from './cursor-log.js';

/** Bracketed paste. Without it the terminal hands pasted text over as ordinary
 * keystrokes, so every newline inside a paste reads as Enter -- which submitted
 * or queued each pasted line as its own separate message. With it the terminal
 * fences the payload and the whole thing arrives as one key. */
export const ENABLE_BRACKETED_PASTE = '\u001b[?2004h';

export const DISABLE_BRACKETED_PASTE = '\u001b[?2004l';

/** Focus reporting and theme notifications are turned OFF on the way out and
 * never on. Both doc comments here used to argue the opposite -- that each was
 * enabled for what announcing it means, captured from Claude Code in a pty --
 * but the enable constants had no caller, so the claim described an intention
 * rather than the code. Clearing them on teardown still earns its place: a
 * program that ran before this one may have left either set. */
export const DISABLE_FOCUS_REPORTING = '\u001b[?1004l';

export const DISABLE_THEME_NOTIFICATIONS = '\u001b[?2031l';

/** Mouse tracking: normal (1000), button-event (1002), any-event (1003), SGR
 * encoding (1006). All four, and a swipe does not scroll without all four.
 *
 * Only motion and wheel reports are acted on, so 1002 and 1003 look
 * redundant. They are not: a client may require the tracking level it was
 * asked for before it routes a gesture to the application at all. Asking for
 * only 1000 and 1006 is click tracking, and a phone sends nothing for a swipe
 * under it -- with no page keys, that leaves no way to read a conversation
 * back. Verified against a capture of a working client on the target device,
 * which is the only thing that settles this; reading the tracking levels and
 * reasoning about which ones are needed gives the wrong answer.
 *
 * Presses and drags are decoded and dropped. What they cost is the client's
 * own selection gesture, hence the usual "hold Shift while selecting" advice.
 *
 * `?1006h` is the SGR encoding; the wheel arrives as button 64 and 65. */
export const ENABLE_MOUSE_TRACKING = '\u001b[?1000h\u001b[?1002h\u001b[?1003h\u001b[?1006h';

export const DISABLE_MOUSE_TRACKING = '\u001b[?1006l\u001b[?1003l\u001b[?1002l\u001b[?1000l';

/** The opening form, used once when the program takes the screen. The `?1006l`
 * before `?1006h` is deliberate and comes from the bare script that receives
 * the gesture on this user's phone when ClikCode does not: it makes SGR
 * reporting a transition rather than a no-op, so a client deciding how to
 * route touches has something to notice.
 *
 * It exists as a named constant so that every enable site is greppable through
 * one name. Spelled out inline, this one escaped the first pass at gating the
 * modes behind SELECTION_MODE, and /select did nothing as a result. */
export const OPENING_MOUSE_TRACKING = '\u001b[?1000h\u001b[?1002h\u001b[?1003h\u001b[?1006l\u001b[?1006h';

/** Selection mode: the mouse handed back to the terminal.
 *
 * Any-event tracking (?1003h) is what makes a swipe scroll the transcript --
 * and it is also what stops the terminal performing its own text selection,
 * because every drag is delivered here instead. There is no setting that
 * gives both. So this releases all four modes on request: swipe-scroll stops
 * working, and selecting and copying chat text starts.
 *
 * Read by the resize handler as well as by setup. Re-asserting the modes
 * after a resize is what makes swipe-scroll survive the phone keyboard
 * appearing; without this flag it would also silently cancel selection mode
 * the moment the keyboard moved. */
export const SELECTION_MODE = { active: false };

/** SGR: `CSI < button ; column ; row M|m`. Wheel up is 64, wheel down 65. */
const MOUSE_EVENT = /^\u001b\[<(\d+);\d+;\d+[Mm]$/;

/** X10: `CSI M` then button and two coordinates, each offset by 32. A client
 * that ignores the SGR request reports in this form, and it is the older and
 * more widely implemented of the two -- so it is decoded, not assumed away. */
export const LEGACY_MOUSE_PREFIX = '\u001b[M';

const LEGACY_MOUSE_EVENT = new RegExp(`^${'\\u001b\\[M'}[\\s\\S]{3}$`);

/** Rows to scroll for a mouse report, or zero for one that is not the wheel. */
export function wheelScrollRows(key: string): number {
  const sgr = MOUSE_EVENT.exec(key);
  const button = sgr
    ? Number(sgr[1])
    : LEGACY_MOUSE_EVENT.test(key) ? (key.charCodeAt(LEGACY_MOUSE_PREFIX.length) - 32) : undefined;
  if (button === undefined) return 0;
  // Three rows a notch, the rate a terminal scrolls its own scrollback at.
  if (button === 64) return SWIPE_ROWS;
  if (button === 65) return -SWIPE_ROWS;
  return 0;
}

export const isMouseEvent = (key: string): boolean => MOUSE_EVENT.test(key) || LEGACY_MOUSE_EVENT.test(key);

/** Rows one notch of a wheel, or one arrow press standing in for a swipe,
 * moves the transcript. The rate a terminal scrolls its own scrollback at. */
export const SWIPE_ROWS = 3;

/** Raw mode, and the record of it, in one place.
 *
 * They were two: `input.setRawMode(false)` at the end of a prompt, a picker, a
 * waiting band or a vendor handover, and `terminalModes.rawMode` left saying
 * `true` because only two of the seven exits cleared it. Everything that asks
 * the terminal a question checks that flag first, for a good reason -- with
 * echo on, the line discipline prints the terminal's answer as text and hands
 * it to whatever reads stdin next. So a resize between two prompts (a phone's
 * keyboard, which resizes the screen every time it opens) sent a DSR into a
 * cooked terminal, and its answer -- `^[[31;54R` -- was echoed and typed
 * straight into the composer.
 *
 * Every entry and exit goes through here now, so the flag cannot disagree with
 * the terminal about what mode it is in. */
/** Raw mode is HELD for the session, and dropped only when the terminal is
 * handed to something else -- close, suspend, suspend-to-shell.
 *
 * It used to be dropped at the end of every prompt, picker and palette and
 * taken again at the start of the next: seven tcsetattr cycles a session on
 * the pty, each one a window in which the terminal is briefly cooked. That is
 * what let a DSR answer get echoed into the composer, above. Holding it for
 * the session closes the window, and matches what other terminal UIs do. */
export function setTerminalRawMode(on: boolean): void {
  if (input.isTTY) input.setRawMode(on);
  terminalModes.rawMode = on;
}

/** Sequences for entering an interactive read. The kitty flag is pushed at most
 * once however many reads start, so one pop always restores the user's own. */
export function enterInputModes(): string {
  // A mode already set emits nothing.
  //
  // Modelled on Claude Code's own mode stack, read out of its binary: `set()`
  // returns the empty string when the mode is already in its entry list, so a
  // mode is asked for once and never again for as long as it is held. This
  // asked for all four groups at every prompt, every picker and every palette,
  // whether or not they were already on -- dozens of redundant mode changes in
  // a session, each one an event the client on the other end has to interpret.
  //
  // The flags were already tracked here. They were simply never read.
  let sequence = '';
  if (!terminalModes.bracketedPaste) { sequence += ENABLE_BRACKETED_PASTE; terminalModes.bracketedPaste = true; }
  if (!terminalModes.wheelReporting && !SELECTION_MODE.active) {
    sequence += ENABLE_MOUSE_TRACKING;
    terminalModes.wheelReporting = true;
  }
  if (!terminalModes.kittyKeyboard && kittyKeyboardSafe()) {
    sequence += PUSH_KITTY_KEYBOARD;
    terminalModes.kittyKeyboard = true;
  }
  if (sequence) logCursorEvent(`input modes asked: ${JSON.stringify(sequence)}`);
  return sequence;
}

/** What a single read owns, and nothing else.
 *
 * The kitty flag is pushed per read, so one pop belongs at the end of each.
 * The rest -- bracketed paste, mouse tracking, focus and theme reporting --
 * belong to the SESSION, and dropping them between prompts is what cost the
 * wheel: captured from Claude Code in this user's own terminal, it sets those
 * modes once at startup and the only disables in 185KB of output are at exit,
 * while this code turned them off at every submit, every picker and every
 * palette. A client with no tracking on at the moment its keyboard slides
 * away has no reason to forward the swipe that follows, and claims the
 * gesture for itself instead.
 *
 * They come back off in leaveInputModes(), which is for handing the terminal
 * to something else: a suspend, a vendor CLI, an exit. */
export function popReadModes(): string {
  if (!terminalModes.kittyKeyboard) return '';
  terminalModes.kittyKeyboard = false;
  return POP_KITTY_KEYBOARD;
}

function leaveInputModes(): string {
  const sequence = `${terminalModes.kittyKeyboard ? POP_KITTY_KEYBOARD : ''}${DISABLE_BRACKETED_PASTE}${DISABLE_MOUSE_TRACKING}${DISABLE_THEME_NOTIFICATIONS}${DISABLE_FOCUS_REPORTING}`;
  terminalModes.kittyKeyboard = false;
  terminalModes.bracketedPaste = false;
  terminalModes.wheelReporting = false;
  return sequence;
}

/** Turn selection mode on or off, returning what the user should be told.
 * Idempotent per direction: setting it to what it already is still writes the
 * modes, because a client may have dropped them on its own. */
export function setSelectionMode(active: boolean): string {
  SELECTION_MODE.active = active;
  if (active) {
    output.write(DISABLE_MOUSE_TRACKING);
    terminalModes.wheelReporting = false;
    return 'Selection mode on — select and copy with your terminal as usual. Swipe-scrolling is off until you run /select again.';
  }
  output.write(ENABLE_MOUSE_TRACKING);
  terminalModes.wheelReporting = true;
  return 'Selection mode off — swipe-scrolling is back.';
}
