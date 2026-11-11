/** The terminal's mode vocabulary: the escape sequences ClikCode sets, the
 * raw-mode flag they depend on, and selection mode. */

import { kittyKeyboardSafe, POP_KITTY_KEYBOARD, PUSH_KITTY_KEYBOARD } from './keys.js';
import { stdin as input } from 'node:process';
import { MOUSE_MODES_OFF, signalsTeardown, terminalModes, terminalTeardown } from './restore.js';
import { FOCUS_REPORTING_ON } from './terminal-signals.js';
import { inlineHistoryMode } from './inline.js';

/** Bracketed paste. Without it the terminal hands pasted text over as ordinary
 * keystrokes, so every newline inside a paste reads as Enter -- which submitted
 * or queued each pasted line as its own separate message. With it the terminal
 * fences the payload and the whole thing arrives as one key. */
const ENABLE_BRACKETED_PASTE = '\u001b[?2004h';

/** Mouse tracking: normal (1000), button-event (1002), any-event (1003), SGR encoding (1006). OPT-IN (CLIKCODE_MOUSE=1), never the default.
 *
 * Any mouse reporting is what stops a client doing its own text selection, because every press and drag goes to the program
 * instead; there is no setting that gives both. The default keeps the client's selection (long-press, drag, copy) and reads the
 * conversation back by key and by what the client turns a wheel or swipe into when no mouse mode is set: arrows, in the alternate
 * screen (see ALTERNATE_SCROLL_ON). Opting in gives the program the wheel and its own selection, the way a phone page that
 * forwards a swipe only under tracking needs: all four modes, because a client may route a gesture to the program only at the
 * level it was asked for. */
const MOUSE_TRACKING_ON = '\u001b[?1000h\u001b[?1002h\u001b[?1003h\u001b[?1006l\u001b[?1006h';

/** Alternate scroll (xterm `?1007`): with no mouse mode set, the client sends Up/Down for a wheel notch while the alternate screen is up. xterm.js and
 * most terminals do it on their own; this asks the ones that have it off by default. Reset on the way out by terminalTeardown, on both screens,
 * and only if this UI set it (what it was before is not known). */
export const ALTERNATE_SCROLL_ON = '\u001b[?1007h';
const ALTERNATE_SCROLL_OFF = '\u001b[?1007l';

/** Whether the program asks for the mouse at all: only when opted in, and never inline (the client scrolls its own scrollback there). */
export function mouseWanted(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLIKCODE_MOUSE === '1' && !inlineHistoryMode(env);
}

/** Wheel reports only (`?1000` press/release + SGR `?1006`; no drag `?1002`, no motion `?1003`), for ClikDeploy's phone page
 * (CLIKDEPLOY_CLIENT=mobile). That page owns every touch and makes its selection itself (term.select), so mouse reporting costs it
 * nothing, and under tracking it sends a swipe as wheel reports instead of arrow keys: a swipe then has a channel of its own and can
 * never be read as history recall or a cursor move (swipe-arrows.ts has the whole rule). Button reports (a tap's synthetic click)
 * are consumed and ignored: they never select, focus or edit. */
const WHEEL_TRACKING_ON = '\u001b[?1000h\u001b[?1006l\u001b[?1006h';

export function wheelOnlyWanted(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLIKDEPLOY_CLIENT === 'mobile' && !mouseWanted(env) && !inlineHistoryMode(env);
}

/** The program reads a wheel as wheel reports (either mode above), so a swipe never arrives as arrow keys. */
export function wheelWanted(env: NodeJS.ProcessEnv = process.env): boolean {
  return mouseWanted(env) || wheelOnlyWanted(env);
}
const ENABLE_MOUSE_TRACKING = (): string => (mouseWanted() ? MOUSE_TRACKING_ON : wheelOnlyWanted() ? WHEEL_TRACKING_ON : '');

/** Selection mode, for the opt-in mouse only: the mouse handed back to the terminal for a while (`/select`). With the default there is
 * nothing to hand back: the client's selection always works. */
export const SELECTION_MODE = { active: false };

/** The session's modes, as one thing: bracketed paste, the mouse (unless
 * /select gave it back), focus reports. Switched on when the screen is taken
 * and again when it is taken BACK -- from a `!` command, a picker that
 * leaves the screen, Ctrl+Z -- and off for each of those hand-overs. These
 * two, sessionModesOff and redrawPreamble are the only places that change
 * them, and each returns what to write rather than writing it, so it goes
 * out inside a frame. The record is kept by the same call that writes the
 * sequence, so it cannot drift from the terminal: it did, when a hand-over
 * switched the modes off and left the record saying on, and nothing ever
 * switched them back -- a swipe stopped scrolling and a paste was read as
 * keystrokes for the rest of the session.
 */
export function sessionModesOn(): string {
  terminalModes.bracketedPaste = true;
  terminalModes.wheelReporting = wheelWanted() && !SELECTION_MODE.active;
  const mouse = SELECTION_MODE.active ? '' : ENABLE_MOUSE_TRACKING();
  // Under wheel reporting alternate scroll is cleared, not just left unasked: a predecessor this process re-exec'd from (an older
  // build, or one started without the client marker) may have set it, and nothing would reset it on the way out.
  const scroll = inlineHistoryMode() ? '' : wheelWanted() ? ALTERNATE_SCROLL_OFF : ALTERNATE_SCROLL_ON;
  terminalModes.alternateScroll = scroll === ALTERNATE_SCROLL_ON;
  // The kitty keyboard flag (Shift+Enter told from Enter) is a session mode too: pushed once with the others, popped only by
  // sessionModesOff. Pushed and popped around every prompt, it went out on its own between frames dozens of times a session.
  const kitty = !terminalModes.kittyKeyboard && kittyKeyboardSafe() ? PUSH_KITTY_KEYBOARD : '';
  if (kitty) terminalModes.kittyKeyboard = true;
  return `${ENABLE_BRACKETED_PASTE}${mouse}${scroll}${FOCUS_REPORTING_ON}${kitty}`;
}

/** Every session mode off, and the title and progress handed back, for
 * giving the terminal to something else. `leavingAlternateScreen` when the
 * main screen goes with it (Ctrl+Z). */
export function sessionModesOff(leavingAlternateScreen: boolean): string {
  terminalModes.bracketedPaste = false;
  terminalModes.wheelReporting = false;
  return `${popKittyKeyboard()}${terminalTeardown(leavingAlternateScreen)}${signalsTeardown()}`;
}

/** What a frame that draws rows writes first, by why it is drawn.
 *
 * After a resize it is the sequence Claude Code sends on the user's phone,
 * captured there, and the only thing that keeps a swipe scrolling with the
 * keyboard hidden (the keyboard sliding away IS a resize):
 *
 *     ?1000h ?1002h ?1003h ?1006h  ?25l  ESC[2J ESC[H  ...rows
 *
 * Both halves matter. Without the clear a swipe stopped scrolling
 * (2026-10-03, when the clear was taken off every full frame to keep a
 * settling reply from flashing). The mouse modes are part of it only when
 * the program asks for the mouse (CLIKCODE_MOUSE=1, mouseWanted; or the
 * wheel-only pair for ClikDeploy's phone page, wheelOnlyWanted); otherwise
 * they are not sent, and a swipe is the arrow keys the client
 * makes of it under alternate scroll (`?1007`, sessionModesOn). The pty
 * suite checks the sequence after every resize burst.
 *
 * `repair` (Ctrl+L) clears and homes, and a frame drawn for any other reason
 * (a reply settling) never clears. Autowrap goes off before any row. */
export type Redraw = 'resize' | 'repair';
export function redrawPreamble(redraw: Redraw | undefined): string {
  // Autowrap off goes before every frame; the caret is hidden only where the
  // screen is cleared. An ordinary diff frame leaves it alone: the cursor is
  // parked absolutely at the end of the frame, and hiding and showing it on
  // every spinner tick made the caret blink under the user's typing.
  const hide = '\u001b[?25l\u001b[?7l';
  if (redraw === 'resize') return `${SELECTION_MODE.active ? '' : ENABLE_MOUSE_TRACKING()}${hide}\u001b[2J\u001b[H`;
  if (redraw === 'repair') return `${hide}\u001b[2J\u001b[H`;
  return '\u001b[?7l';
}

/** Mode changes asked for between frames (/select): the next frame writes
 * them first, inside its synchronized update, never interleaved with one
 * already on its way. */
let queuedModes = '';

export function takeQueuedModes(): string {
  const taken = queuedModes;
  queuedModes = '';
  return taken;
}

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

/** Raw mode, and the record of it, in one place, HELD for the session and dropped only when the terminal is handed to something
 * else -- close, suspend, suspend-to-shell.
 *
 * Everything that asks the terminal a question checks the record first, for a good reason: with echo on, the line discipline
 * prints the terminal's answer as text and hands it to whatever reads stdin next. Raw mode used to be dropped at the end of every
 * prompt, picker and palette and taken again at the start of the next -- seven tcsetattr cycles a session, each a window in which
 * the terminal was briefly cooked -- and the record was left saying `true` by five of the seven exits. A resize between two
 * prompts (a phone's keyboard) then sent a DSR into a cooked terminal, and its answer -- `^[[31;54R` -- was echoed and typed into
 * the composer. Holding it, through this one function, closes the window and keeps the record true. */
export function setTerminalRawMode(on: boolean): void {
  if (input.isTTY) input.setRawMode(on);
  terminalModes.rawMode = on;
}

/** This process's kitty keyboard entry popped, if it pushed one (sessionModesOn): when the terminal is handed over, given back,
 * or this process is replaced. The stack belongs to the terminal, so exactly one pop goes with each push. */
export function popKittyKeyboard(): string {
  if (!terminalModes.kittyKeyboard) return '';
  terminalModes.kittyKeyboard = false;
  return POP_KITTY_KEYBOARD;
}

/** Turn selection mode on or off, returning what the user should be told.
 * Idempotent per direction: setting it to what it already is still writes the
 * modes, because a client may have dropped them on its own. */
export function setSelectionMode(active: boolean): string {
  if (!mouseWanted()) {
    return inlineHistoryMode()
      ? 'The terminal\'s own selection is always on: select and copy as usual.'
      : 'The terminal\'s own selection is always on: select and copy as usual. A swipe or wheel, PageUp, PageDown, Home and End read the conversation back.';
  }
  SELECTION_MODE.active = active;
  if (active) {
    queuedModes += MOUSE_MODES_OFF;
    terminalModes.wheelReporting = false;
    return 'Selection mode on — select and copy with your terminal as usual. Swipe-scrolling is off until you run /select again.';
  }
  queuedModes += ENABLE_MOUSE_TRACKING();
  terminalModes.wheelReporting = true;
  return 'Selection mode off — swipe-scrolling is back.';
}
