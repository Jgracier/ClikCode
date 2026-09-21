/** Shared terminal renderer for every harness and the Gateway path. Persisted
 * conversation lines are emitted once into native scrollback; one atomic live
 * region contains only the changing response, controls, and composer. */

import chalk from 'chalk';
import { kittyKeyboardSafe, NEWLINE_KEY, PASTE_END, PASTE_START, pastedText, POP_KITTY_KEYBOARD, PUSH_KITTY_KEYBOARD } from './keys.js';
import { backslashNewline, composerVerticalMove, editComposer, editWaitingComposer } from './composer-edit.js';
import {
  commandPaletteMatches, composerRightArrowValue, exactPaletteCommand, paletteDisplayRows, pickerConfirmsSelection,
  pickerDeletesSelection, SWITCH_HARNESS_GROUP, type PaletteEntry,
} from './command-palette.js';
import { stdin as input, stdout as output } from 'node:process';
import { StringDecoder } from 'node:string_decoder';
import {
  closeOpenHyperlink, composerLayout, createStreamingBlockParser, nextCharacterIndex, previousCharacterIndex,
  renderInlineMarkdown, renderInlineMarkdownLive, renderTableBlock,
  sanitizeTerminalText, splitIntoBlocks, terminalCellWidth, visibleSlice, wrapCodeLine, wrapWords,
} from './render/markdown.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { installTerminalRestoreSignals, restoreTerminal, terminalModes, terminalPrepare, terminalTeardown } from './restore.js';
import { compactPath, harnessSupportsEffort, localHarnessForCommand, renderActivityLine, sessionProviderLabel } from '../harness/transport/native-protocol.js';
import { sessionTranscriptMessages } from '../turn/checkpoint.js';
import { TurnTranscript, type SettlingTool } from '../turn/transcript.js';
import type { HarnessPlanEntry } from '../harness/events/turn-observer.js';
import { nativeModelLabel } from '../harness/account-data.js';
import type { LiveTurnInputResult } from '../turn/live-input.js';
import type { HarnessActivityEvent, HarnessPrompter, HarnessSession, MessageBlock, PickerOption, ToolCategory } from '../harness/types.js';

export { restoreTerminal };

export type WaitingInputAction = 'cancel-edit' | 'cancel-stop';

const ESCAPE_SEQUENCE_TIMEOUT_MS = 120;

/** Treat any set, non-falsy value as opt-in. These are typed by hand into a
 * shell profile, so `0`/`false`/empty must mean off rather than "the variable
 * exists, therefore enabled". */
function environmentFlag(...values: (string | undefined)[]): boolean {
  const value = values.find((candidate) => candidate !== undefined && candidate !== '');
  return value !== undefined && value !== '0' && value.toLowerCase() !== 'false';
}

/** Repainting one live region is what makes the spinner and streaming answer
 * feel immediate, and it is also exactly what a screen reader re-announces on
 * every frame. This mode routes to the existing line-oriented renderer, which
 * is append-only and therefore reads once, in order. */
export function screenReaderMode(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environmentFlag(environment.CLIKCODE_SCREEN_READER);
}

/** Holds the spinner on a single frame and slows the refresh to the rate the
 * elapsed counter actually needs. The turn still streams; only the decorative
 * motion stops. */
export function reducedMotion(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environmentFlag(environment.CLIKCODE_REDUCED_MOTION, environment.NO_MOTION);
}

export function terminalUiSupported(
  stdinTty = Boolean(input.isTTY), stdoutTty = Boolean(output.isTTY), environment: NodeJS.ProcessEnv = process.env,
): boolean {
  // `TERM=dumb` explicitly promises no cursor addressing. The line-oriented
  // fallback remains usable in CI consoles, IDE output panes, Emacs shells,
  // and other pseudo-terminals that expose a TTY without ANSI capabilities.
  if (screenReaderMode(environment)) return false;
  return stdinTty && stdoutTty && environment.TERM?.toLowerCase() !== 'dumb';
}

function waitingInputAction(key: string): WaitingInputAction | undefined {
  if (key === '\u001b') return 'cancel-edit';
  if (key === '\u0003') return 'cancel-stop';
  return undefined;
}

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
/** `CSI I` / `CSI O`: the window gained or lost focus. Never a keystroke. */
const FOCUS_EVENT = /^\u001b\[[IO]$/;
/** `CSI ? ... c`: the terminal answering Primary DA. Never a keystroke. */
const DEVICE_ATTRIBUTES_REPLY = /^\u001b\[\?[0-9;]*c$/;
const EXIT_CONFIRM_MS = 2000;
/** How long a resize burst is given to finish before the screen is redrawn.
 * A phone dismissing its keyboard emits several SIGWINCHes a few tens of
 * milliseconds apart; this is longer than that gap and shorter than a frame a
 * reader would notice missing. */
const RESIZE_SETTLE_MS = 120;
/** The least a pending scroll moves in one frame, so a drain always finishes.
 * Claude Code's value. */
const SCROLL_DRAIN_MIN = 4;
/** One frame, roughly: the gap between drains of an outstanding scroll. */
const SCROLL_DRAIN_MS = 16;

const ENTER_ALTERNATE_SCREEN = '\u001b[?1049h\u001b[2J\u001b[H';
const LEAVE_ALTERNATE_SCREEN = '\u001b[?1049l';
/** Rows kept above the viewport so scrolling back inside a conversation still
 * has somewhere to scroll to. */
const ALTERNATE_TRANSCRIPT_ROWS = 2000;
/** Rows one notch of a wheel, or one arrow press standing in for a swipe,
 * moves the transcript. The rate a terminal scrolls its own scrollback at. */
const SWIPE_ROWS = 3;

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
function enterInputModes(): string {
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
function popReadModes(): string {
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

/** Attached for the life of the prompter so stdin never falls back to paused
 * mode between readers. It reads nothing; presence is the whole point. */
const KEEP_STDIN_FLOWING = (): void => {};


/** `CSI code ; modifiers u` and `CSI 27 ; modifiers ; code ~` back to the bytes
 * a legacy terminal would have sent, or undefined to leave the key alone. */
function legacyKeyFromModified(code: number, modifierField: number): string | undefined {
  // Bit 0 shift, 1 alt, 2 ctrl. Caps/num lock (64/128) say nothing about intent.
  const modifiers = Math.max(0, modifierField - 1) & 0b111;
  const shift = Boolean(modifiers & 1);
  const alt = Boolean(modifiers & 2);
  const ctrl = Boolean(modifiers & 4);
  if (code === 13) return shift || alt || ctrl ? NEWLINE_KEY : '\r';
  if (code === 27) return '\u001b';
  if (code === 9) return shift ? '\u001b[Z' : '\t';
  if (code === 127 || code === 8) return alt || ctrl ? '\u001b\u007f' : '\u007f';
  if (code < 32 || code > 0x10ffff) return undefined;
  const character = String.fromCodePoint(code);
  if (ctrl && alt) return undefined;
  if (ctrl) {
    if (code === 32) return '\u0000';
    const lower = character.toLowerCase();
    return /^[a-z\[\\\]^_]$/.test(lower) ? String.fromCharCode(lower.charCodeAt(0) & 0x1f) : undefined;
  }
  if (alt) return `\u001b${character}`;
  return shift ? character.toUpperCase() : character;
}

function normalizeTerminalKey(key: string): string {
  const csiU = /^\u001b\[(\d+)(?::\d*)*(?:;(\d+)(?::\d+)?)?(?:;[\d:]*)?u$/.exec(key);
  if (csiU) return legacyKeyFromModified(Number(csiU[1]), Number(csiU[2] ?? 1)) ?? key;
  const otherKeys = /^\u001b\[27;(\d+);(\d+)~$/.exec(key);
  if (otherKeys) return legacyKeyFromModified(Number(otherKeys[2]), Number(otherKeys[1])) ?? key;
  const cursor = /^\u001b(?:O|\[(?:1(?:;\d+)?)?)([ABCD])$/.exec(key);
  if (cursor) return `\u001b[${cursor[1]}`;
  const page = /^\u001b\[([56])(?:;\d+)?~$/.exec(key);
  if (page) return `\u001b[${page[1]}~`;
  if (/^\u001b\[(?:1|7)~$/.test(key) || key === '\u001b[H' || key === '\u001bOH') return '\u0001';
  if (/^\u001b\[(?:4|8)~$/.test(key) || key === '\u001b[F' || key === '\u001bOF') return '\u0005';
  return key;
}

/** Stateful decoder for mobile/remote terminals, where one key's escape
 * sequence and even one UTF-8 character may be split across data chunks. */
export class TerminalInputDecoder {
  private readonly utf8 = new StringDecoder('utf8');
  private pending = '';

  push(chunk: Buffer | string): string[] {
    this.pending += typeof chunk === 'string' ? chunk : this.utf8.write(chunk);
    return this.drain(false);
  }

  flush(): string[] {
    this.pending += this.utf8.end();
    return this.drain(true);
  }

  hasPending(): boolean { return this.pending.length > 0; }

  private drain(flush: boolean): string[] {
    const keys: string[] = [];
    while (this.pending) {
      if (this.pending[0] !== '\u001b') {
        const end = nextCharacterIndex(this.pending, 0);
        keys.push(this.pending.slice(0, end));
        this.pending = this.pending.slice(end);
        continue;
      }
      if (this.pending.length === 1) {
        if (flush) { keys.push('\u001b'); this.pending = ''; }
        break;
      }
      if (this.pending.startsWith(PASTE_START)) {
        const close = this.pending.indexOf(PASTE_END);
        if (close === -1) {
          // A large paste spans several chunks; hold until it is fenced.
          if (!flush) break;
          keys.push(this.pending + PASTE_END);
          this.pending = '';
          continue;
        }
        keys.push(this.pending.slice(0, close + PASTE_END.length));
        this.pending = this.pending.slice(close + PASTE_END.length);
        continue;
      }
      const prefix = this.pending[1];
      // DCS: `ESC P ... ST`, where ST is `ESC \\`. The XTVERSION reply arrives
      // this way. Scanning it as a CSI would spray its text into the draft one
      // character at a time, which is the same failure `^[[31;54R` in the
      // composer was.
      if (prefix === 'P') {
        const close = this.pending.indexOf('\u001b\\', 2);
        if (close === -1) {
          if (!flush) break;
          keys.push(this.pending);
          this.pending = '';
          continue;
        }
        keys.push(this.pending.slice(0, close + 2));
        this.pending = this.pending.slice(close + 2);
        continue;
      }
      if (prefix === '[') {
        // X10 mouse reporting: `CSI M` and then exactly three bytes, which are
        // coordinates and not a terminator. Scanning for a final byte stops at
        // the M and leaves those three to be read as text -- a wheel notch
        // typed three characters into the composer instead of scrolling, on
        // every client that does not speak the SGR encoding we ask for.
        if (this.pending.startsWith(LEGACY_MOUSE_PREFIX)) {
          if (this.pending.length < LEGACY_MOUSE_PREFIX.length + 3) {
            if (!flush) break;
            keys.push('\u001b');
            this.pending = this.pending.slice(1);
            continue;
          }
          keys.push(this.pending.slice(0, LEGACY_MOUSE_PREFIX.length + 3));
          this.pending = this.pending.slice(LEGACY_MOUSE_PREFIX.length + 3);
          continue;
        }
        let end = 2;
        while (end < this.pending.length && !/[\x40-\x7e]/.test(this.pending[end]!)) end++;
        if (end >= this.pending.length) {
          if (flush) { keys.push('\u001b'); this.pending = this.pending.slice(1); continue; }
          break;
        }
        keys.push(normalizeTerminalKey(this.pending.slice(0, end + 1)));
        this.pending = this.pending.slice(end + 1);
        continue;
      }
      if (prefix === 'O') {
        if (this.pending.length < 3) {
          if (flush) { keys.push('\u001b'); this.pending = this.pending.slice(1); continue; }
          break;
        }
        keys.push(normalizeTerminalKey(this.pending.slice(0, 3)));
        this.pending = this.pending.slice(3);
        continue;
      }
      if (prefix === '\r' || prefix === '\n' || prefix === '\u007f' || prefix === '\b') {
        // Alt+Enter inserts a newline and Alt+Backspace deletes a word. Both
        // arrive as ESC plus a control byte in one chunk.
        keys.push(prefix === '\r' || prefix === '\n' ? NEWLINE_KEY : '\u001b\u007f');
        this.pending = this.pending.slice(2);
        continue;
      }
      if ((prefix.codePointAt(0) ?? 0) < 0x20) {
        keys.push('\u001b');
        this.pending = this.pending.slice(1);
        continue;
      }
      // Alt+letter stays one key (Alt+B / Alt+F move by word; the rest are
      // ignored) so neither half becomes cancellation or composer text.
      keys.push(this.pending.slice(0, 2));
      this.pending = this.pending.slice(2);
    }
    return keys;
  }
}

/** `ESC [ row ; column R` is the terminal answering DSR, never a keystroke. */
const CURSOR_POSITION_REPORT = /^\u001b\[\d+;\d+R$/;

const cursorReportWaiters = new Set<(report: { row: number; column: number }) => void>();

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


/** A read from the terminal is one batch of keys, and the end of it is
 * announced so a listener can draw once for the whole chunk.
 *
 * Momentum scrolling on a phone does not deliver notches one at a time: a
 * flick arrives as a single read carrying hundreds, over a thousand measured
 * here. Drawing per notch asked the link to carry a full-screen repaint for
 * each -- about 4KB in a long conversation, so one flick is a megabyte, and
 * the client stops forwarding the gesture rather than fall behind. Every notch
 * still moves the offset; they share one frame. */
let keyBatchDepth = 0;
const keyBatchEndListeners = new Set<() => void>();
export function onKeyBatchEnd(listener: () => void): () => void {
  keyBatchEndListeners.add(listener);
  return () => { keyBatchEndListeners.delete(listener); };
}
export function inKeyBatch(): boolean { return keyBatchDepth > 0; }

function listenForTerminalKeys(onKey: (key: string) => void): () => void {
  const decoder = new TerminalInputDecoder();
  let flushTimer: NodeJS.Timeout | undefined;
  const deliver = (keys: readonly string[]): void => {
    keyBatchDepth += 1;
    try { deliverKeys(keys); } finally {
      keyBatchDepth -= 1;
      if (keyBatchDepth === 0) for (const listener of [...keyBatchEndListeners]) listener();
    }
  };
  const deliverKeys = (keys: readonly string[]): void => {
    for (const key of keys) {
      // Escape sequences only -- never typed text, which is the user's message.
      // What a client sends for a swipe cannot be read from this end any other
      // way, and "scrolling does nothing" has three possible causes that look
      // identical from here: no report sent, a report in an encoding we do not
      // decode, or a report decoded and then dropped.
      // Escape sequences and control keys -- never typed text, which is the
      // user's message. Ctrl+B arrives as \u0002, which the escape-only rule
      // here did not record, so a report of "the key does nothing" could not
      // be told apart from "the key never arrived".
      if (key.startsWith('\u001b') || key.charCodeAt(0) < 0x20) {
        logCursorEvent(`input ${JSON.stringify(key)} screen=${output.columns ?? '?'}x${output.rows ?? '?'}`);
      }
      // A DSR reply is the terminal talking back, not the user typing.
      // Nothing here asks for one any more, but a terminal may volunteer it
      // and it must never be typed into the draft.
      if (CURSOR_POSITION_REPORT.test(key)) continue;
      // Focus in/out and OSC replies (theme notifications), likewise:
      // enabled for what they announce, not to be read.
      if (FOCUS_EVENT.test(key) || key.startsWith('\u001b]')) continue;
      // Answers to the questions the opening handshake asks: Primary DA comes
      // back as `CSI ? ... c`, XTVERSION as a DCS string. Neither is a key,
      // and a terminal that answers must not be able to type into the draft.
      if (DEVICE_ATTRIBUTES_REPLY.test(key) || key.startsWith('\u001bP')) continue;
      onKey(key);
    }
  };
  const onData = (chunk: Buffer | string): void => {
    if (flushTimer) clearTimeout(flushTimer);
    deliver(decoder.push(chunk));
    if (decoder.hasPending()) {
      // A lone Escape must eventually be delivered, but mobile SSH links can
      // split a cursor/mouse sequence across packets by more than one frame.
      flushTimer = setTimeout(() => deliver(decoder.flush()), ESCAPE_SEQUENCE_TIMEOUT_MS);
      flushTimer.unref();
    }
  };
  input.on('data', onData);
  return () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = undefined;
    input.off('data', onData);
  };
}

/** Decode only keys that remain meaningful while a provider turn owns the
 * composer. Keeping this separate from cancellation prevents arrow/page keys
 * from being swallowed during generation. */
export function waitingInputActions(chunk: Buffer | string): WaitingInputAction[] {
  const decoder = new TerminalInputDecoder();
  return [...decoder.push(chunk), ...decoder.flush()].flatMap((key) => {
    const action = waitingInputAction(key);
    return action ? [action] : [];
  });
}


/** A fixed 4x4 field of identical tiny dots. Four diagonal phases move through
 * the same compact shape without changing its dimensions. */
export function waitingSpinnerFrame(frame: number): [boolean[], boolean[], boolean[], boolean[]] {
  const phase = Math.abs(frame) % 4;
  return Array.from({ length: 4 }, (_, row) =>
    Array.from({ length: 4 }, (_, column) => (row + column + phase) % 4 < 2),
  ) as [boolean[], boolean[], boolean[], boolean[]];
}

/** Pack the logical 4x4 animation into two adjacent Braille cells. A Braille
 * cell is itself a 2x4 dot matrix, so this preserves all sixteen positions in
 * one terminal row without the four-row gap shown by ordinary periods. */
export function waitingSpinnerGlyph(frame: number): string {
  const grid = waitingSpinnerFrame(frame);
  const bit = (column: number, row: number): number => {
    const positions = [[0, 1, 2, 6], [3, 4, 5, 7]] as const;
    return grid[row]![column] ? 1 << positions[column % 2]![row] : 0;
  };
  return [0, 2].map((start) => String.fromCodePoint(0x2800
    | bit(start, 0) | bit(start, 1) | bit(start, 2) | bit(start, 3)
    | bit(start + 1, 0) | bit(start + 1, 1) | bit(start + 1, 2) | bit(start + 1, 3))).join('');
}

/** Fill a terminal-width rule from the left and pin a short label to its
 * right edge. Both composer borders use this same layout: usage above and
 * the conversation title below. */
export function rightLabeledRule(width: number, label?: string): string {
  const suffix = label ? ` ${visibleSlice(label, Math.max(0, width - 4))}` : '';
  return `${'─'.repeat(Math.max(0, width - terminalCellWidth(suffix)))}${suffix}`;
}

/** A live response must end on content, not its decorative separator. On a
 * short mobile viewport the last replaceable row may be the only row visible. */
export function liveConversationLines(lines: readonly string[], live: boolean): string[] {
  const result = [...lines];
  if (live) while (result[result.length - 1] === '') result.pop();
  return result;
}

/** Keep the persisted history window stable while transient assistant and
 * queued rows are appended. Applying the history cap to the combined array
 * drops its first persisted row, breaks the native-scrollback prefix, and
 * causes every live frame to be rejected until the final commit. */
/** One rendered activity row and where it belongs: the message index it was
 * reported under, and -- for a row produced inside a turn -- the response
 * offset it started at, which is where it is written back into the prose. */
export type ActivityEntry =
  { anchor: number; responseOffset?: number; sequence?: number; event?: HarnessActivityEvent; lines: string[] };
/** One provider may publish pending/running/progress frames for the same tool.
 * They describe one lifecycle, not separate calls. Upsert by native id, or by
 * the latest still-open matching label when a protocol omits ids. */
export function upsertActivityEvent(
  entries: readonly ActivityEntry[], anchor: number, responseOffset: number | undefined, event: HarnessActivityEvent, sequence?: number,
): ActivityEntry[] {
  // A thought is never a transcript row: reasoning summaries arrive dozens per
  // turn and would bury the answer. The prompter shows the latest one on a
  // single live row instead (see TerminalHarnessPrompter.activityEvent).
  if (event.kind === 'thinking') return [...entries];
  // Tool labels, output and diffs are untrusted text. They are cleaned before
  // renderActivityLine styles them, so the only escapes left in a row are the
  // color codes this UI added itself.
  const cleanLines = (lines: readonly string[]): string[] => lines.map((line) => sanitizeTerminalText(line, { singleLine: true }));
  const normalized: HarnessActivityEvent = {
    ...event,
    label: visibleSlice(sanitizeTerminalText(event.label, { singleLine: true }).replace(/\s+/g, ' ').trim() || 'tool', 120),
    ...(event.output ? { output: cleanLines(event.output) } : {}),
    ...(event.diff ? { diff: { ...event.diff, removed: cleanLines(event.diff.removed), added: cleanLines(event.diff.added) } } : {}),
  };
  const matchIndex = (() => {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      if (entry.anchor !== anchor || entry.event?.kind !== 'tool-start') continue;
      if (normalized.id ? entry.event.id === normalized.id
        : entry.event.label === normalized.label) return index;
    }
    return -1;
  })();
  const next = [...entries];
  if (matchIndex >= 0) {
    const prior = next[matchIndex]!;
    const effective = {
      ...normalized,
      ...(normalized.label === 'tool' ? { label: prior.event!.label } : {}),
      // A completion frame routinely carries neither the name nor the input
      // the category was derived from. The row keeps what its start knew.
      ...(normalized.category ? {} : prior.event?.category ? { category: prior.event.category } : {}),
      ...(normalized.diff ? {} : prior.event?.diff ? { diff: prior.event.diff } : {}),
    };
    next[matchIndex] = { ...prior, event: effective, lines: renderActivityLine(effective).map((line) => line.trim()) };
  } else {
    next.push({
      anchor, ...(responseOffset === undefined ? {} : { responseOffset }), ...(sequence === undefined ? {} : { sequence }),
      event: normalized, lines: renderActivityLine(normalized).map((line) => line.trim()),
    });
  }
  // Do not evict old entries here. Some may already be immutable native
  // scrollback; removing one would invalidate the rendered prefix and force a
  // full-screen reset. No entry is ever collapsed into a count either: a row
  // whose text can still change could never enter scrollback at all.
  return next;
}

/** A replacement stream is usually a cumulative snapshot. Offsets within its
 * unchanged prefix remain valid; offsets in rewritten text do not, so attach
 * those events at the divergence boundary instead of leaving them beyond or
 * inside unrelated prose. */
export function rebaseActivityOffsets(
  entries: readonly ActivityEntry[], anchor: number, previous: string, replacement: string,
): ActivityEntry[] {
  let commonPrefix = 0;
  const shared = Math.min(previous.length, replacement.length);
  while (commonPrefix < shared && previous[commonPrefix] === replacement[commonPrefix]) commonPrefix += 1;
  return entries.map((entry) => entry.anchor === anchor && entry.responseOffset !== undefined
    && entry.responseOffset > commonPrefix
    ? { ...entry, responseOffset: commonPrefix }
    : entry);
}

/** Derive the spinner from the whole in-flight tool set rather than the most
 * recent provider event. A reasoning summary or one parallel completion must
 * not claim the agent is merely thinking while another tool is still live. */
/** One place decides how a category looks and reads, for the retired row, the
 * running row and the spinner alike. The glyph stays the same for every
 * category on purpose: the shape is the transcript's, the colour is the
 * tool's. Nothing is spelled out in front of a label -- the label already
 * says `Read(...)` or `Bash(...)`, so colour is an aid here, not the only
 * carrier, and a NO_COLOR terminal loses nothing it needs. */
export const TOOL_CATEGORY_STYLE: Record<ToolCategory, { paint: (text: string) => string; verb: string }> = {
  read: { paint: (text) => chalk.blue(text), verb: 'reading' },
  edit: { paint: (text) => chalk.magenta(text), verb: 'editing' },
  run: { paint: (text) => chalk.yellow(text), verb: 'running' },
  search: { paint: (text) => chalk.cyan(text), verb: 'searching' },
  fetch: { paint: (text) => chalk.green(text), verb: 'fetching' },
};

export function activityLifecyclePhase(
  activeTools: ReadonlyMap<string, { label: string; category?: ToolCategory }>, event: HarnessActivityEvent,
): { activeTools: Map<string, { label: string; category?: ToolCategory }>; phase: string; category?: ToolCategory } {
  const next = new Map(activeTools);
  const key = event.id ?? event.label;
  if (event.kind === 'tool-start') next.set(key, { label: event.label, ...(event.category ? { category: event.category } : {}) });
  else if (event.kind === 'tool-done' || event.kind === 'tool-error') {
    if (!next.delete(key) && !event.id) {
      const matchingKey = [...next].reverse().find(([, tool]) => tool.label === event.label)?.[0];
      if (matchingKey) next.delete(matchingKey);
    }
  }
  const running = [...next.values()];
  const current = running[running.length - 1];
  if (!current) return { activeTools: next, phase: 'thinking' };
  // The verb is what the tool is doing, not a generic "running" for
  // everything. An unclassified tool keeps the word it always had.
  const verb = current.category ? TOOL_CATEGORY_STYLE[current.category].verb : 'running';
  return {
    activeTools: next, phase: `${verb} ${current.label}`,
    ...(current.category ? { category: current.category } : {}),
  };
}

export function transientAssistantRequired(
  liveResponse: string, waiting: boolean, transcriptLength: number, entries: readonly ActivityEntry[],
): boolean {
  return Boolean(liveResponse || (waiting && entries.some((entry) =>
    entry.anchor === transcriptLength && entry.responseOffset !== undefined)));
}

/** How long an approval ignores every key after it appears. A person typing
 * into the composer cannot stop within a frame of a prompt popping up; without
 * this the `y` of whatever word they were on approved a tool call. */
export const APPROVAL_GUARD_MS = 400;

export type ApprovalPreview = {
  /** Either unified-diff style lines, or the two sides of an edit. */
  diff?: readonly string[] | { removed: readonly string[]; added: readonly string[] };
};
type ApprovalRequest = { title: string; detail?: string; preview?: ApprovalPreview; resolve: (accepted: boolean) => void };
const APPROVAL_DIFF_PREVIEW_LINES = 8;

/** What one key means to a pending approval. The rule, in full:
 *  - every key is ignored for the first APPROVAL_GUARD_MS;
 *  - Esc and Ctrl+C always deny (neither can be part of a draft);
 *  - if the composer held a draft when the approval appeared, Tab must be
 *    pressed first to focus the approval -- until then y/n/Enter are ignored,
 *    because they are exactly the characters the user is in the middle of
 *    typing;
 *  - then y/Y allows once, n/N and Enter (the default) deny.
 * Nothing typed while an approval is pending ever reaches the draft. */
export function approvalKeyAction(
  key: string, elapsedMs: number, needsFocus: boolean, focused: boolean,
): 'allow' | 'deny' | 'focus' | 'ignore' {
  if (elapsedMs < APPROVAL_GUARD_MS) return 'ignore';
  if (key === '\u001b' || key === '\u0003') return 'deny';
  if (needsFocus && !focused) return key === '\t' ? 'focus' : 'ignore';
  if (key === 'y' || key === 'Y') return 'allow';
  if (key === 'n' || key === 'N' || key === '\r' || key === '\n') return 'deny';
  return 'ignore';
}

/** The approval as its own block of rows. The full command/path is wrapped,
 * never clipped to a fragment of one status line, and the answer row is never
 * truncated: what is being approved and how to answer are the two things this
 * prompt exists to show. When the block cannot fit, detail rows are dropped
 * from the middle and the count of hidden rows is stated. */
export function approvalBlockRows(
  request: { title: string; detail?: string; preview?: ApprovalPreview }, width: number, maxRows: number,
  state: { guarded: boolean; needsFocus: boolean; focused: boolean; queued: number },
): string[] {
  const inner = Math.max(8, width - 4);
  const clean = (text: string): string => sanitizeTerminalText(text);
  const title = wrapWords(`${clean(request.title).replace(/\s+/g, ' ').trim()}${state.queued ? `  (+${state.queued} waiting)` : ''}`, inner - 2)
    .map((line, index) => `  ${index === 0 ? chalk.yellow('?') : ' '} ${chalk.bold(line)}`);
  const detail = request.detail === undefined ? []
    : clean(request.detail).split('\n').flatMap((line) => wrapCodeLine(line, inner - 2)).map((line) => `    ${line}`);
  const diffSource = request.preview?.diff;
  const diffLines = !diffSource ? []
    : Array.isArray(diffSource) ? (diffSource as readonly string[]).map((line) => clean(line))
      : [
        ...(diffSource as { removed: readonly string[] }).removed.map((line) => `- ${clean(line)}`),
        ...(diffSource as { added: readonly string[] }).added.map((line) => `+ ${clean(line)}`),
      ];
  const shownDiff = diffLines.slice(0, APPROVAL_DIFF_PREVIEW_LINES).map((line) => {
    const clipped = visibleSlice(line.replace(/\n/g, ' '), inner - 2);
    return `    ${line.startsWith('+') ? chalk.green(clipped) : line.startsWith('-') ? chalk.red(clipped) : clipped}`;
  });
  if (diffLines.length > shownDiff.length) shownDiff.push(`    ${chalk.dim(`+${diffLines.length - shownDiff.length} more`)}`);
  const keys = width >= 46 ? '[y] yes  [n] no  [esc] deny' : '[y] [n] [esc]';
  const question = state.needsFocus && !state.focused
    ? (width >= 72 ? `Draft kept. Press [tab] to answer, then ${keys}` : `[tab] to answer · ${keys}`)
    : `Allow once? ${keys}`;
  const answer = `  ${state.guarded ? chalk.dim(question) : chalk.bold(question)}`;
  const body = [...detail, ...shownDiff];
  const room = Math.max(0, maxRows - title.length - 1);
  if (body.length > room) {
    const kept = Math.max(0, room - 1);
    const hidden = body.length - kept;
    body.splice(kept, body.length - kept, ...(room > 0 ? [`    ${chalk.dim(`… ${hidden} more row${hidden === 1 ? '' : 's'}`)}`] : []));
  }
  return [...title.slice(0, Math.max(1, maxRows - 1)), ...body, answer];
}

/** The shared shape, so a plan entry means the same thing whichever harness
 * produced it. Status is compared, never exhaustively matched: a harness may
 * publish anything, and anything unrecognised reads as not-yet-done. */
export type PlanEntry = HarnessPlanEntry;
const PLAN_MAX_ROWS = 6;

/** A compact todo block: at most PLAN_MAX_ROWS rows, windowed around the step
 * in progress so a long plan never crowds the conversation out of view. */
export function planBlockRows(entries: readonly PlanEntry[], width: number, maxRows = PLAN_MAX_ROWS): string[] {
  if (!entries.length || maxRows < 1) return [];
  const done = entries.filter((entry) => entry.status === 'completed').length;
  const capacity = Math.max(1, Math.min(maxRows, PLAN_MAX_ROWS));
  let visible = entries.map((entry, index) => ({ entry, index }));
  if (visible.length > capacity) {
    const active = Math.max(0, entries.findIndex((entry) => entry.status !== 'completed'));
    const start = Math.max(0, Math.min(active - 1, entries.length - (capacity - 1)));
    visible = visible.slice(start, start + capacity - 1);
  }
  const rows = visible.map(({ entry }) => {
    const text = visibleSlice(sanitizeTerminalText(entry.content, { singleLine: true }).trim(), Math.max(4, width - 6));
    return entry.status === 'completed' ? `  ${chalk.green('☑')} ${chalk.dim(text)}`
      : entry.status === 'in_progress' ? `  ${chalk.cyan('◐')} ${chalk.bold(text)}` : `  ☐ ${text}`;
  });
  if (visible.length < entries.length) rows.push(`  ${chalk.dim(`  ${done}/${entries.length} done · ${entries.length - visible.length} more`)}`);
  return rows;
}

const compactCount = (count: number): string => (count < 1000 ? String(count)
  : count < 1_000_000 ? `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k` : `${(count / 1_000_000).toFixed(1)}M`);

/** `↑ 1.2k ↓ 340 tokens`, or an empty string before the harness reports any. */
export function formatTurnUsage(usage?: { inputTokens?: number; outputTokens?: number }): string {
  const parts = [
    ...(usage?.inputTokens ? [`↑ ${compactCount(usage.inputTokens)}`] : []),
    ...(usage?.outputTokens ? [`↓ ${compactCount(usage.outputTokens)}`] : []),
  ];
  return parts.length ? `${parts.join(' ')} tokens` : '';
}

/** Rows for a run of parsed Markdown blocks, exactly as they appear in the
 * transcript.
 *
 * Append-only: a row this returns is written into the terminal's own
 * scrollback once and never addressed again, so the same blocks must produce
 * the same rows whether they are rendered while an answer streams or when its
 * persisted copy arrives. `firstOfMessage` puts the message's marker on the
 * very first row; every later row is indented under it. `live` renders the
 * final block with the streaming inline renderer, whose output does not change
 * shape as the rest of a construct arrives.
 */
export function renderMessageBlocks(
  blocks: readonly MessageBlock[], marker: string, width: number, firstOfMessage = true, live = false,
): string[] {
  const rows: string[] = [];
  let firstLine = firstOfMessage;
  const linePrefix = (): string => {
    const prefix = firstLine ? `${marker} ` : '  ';
    firstLine = false;
    return prefix;
  };
  for (const [index, block] of blocks.entries()) {
    const streaming = live && index === blocks.length - 1;
    // Blocks are separated by an empty row -- a paragraph, a list, a fence and
    // the paragraph after it are separate things and read as one wall of text
    // without it. Consecutive items of the same list are not separated: a list
    // is one thing. The separator belongs to the block that FOLLOWS, never to
    // the one before it: a row handed to scrollback can never grow a row, and
    // a streaming answer's blocks are handed over as each one closes.
    // A run that continues a message (firstOfMessage false) is separated from
    // whatever the earlier run wrote for the same reason.
    const previous = index ? blocks[index - 1] : undefined;
    const tight = previous?.kind === 'list-item' && block.kind === 'list-item';
    if ((previous || !firstOfMessage) && !tight) rows.push('');
    const quotePrefix = block.quoteDepth ? chalk.dim('│ '.repeat(block.quoteDepth)) : '';
    if (block.kind === 'code') {
      const structural = `${quotePrefix}${'  '.repeat(block.indent)}`;
      for (const codeLine of [...(block.language ? [chalk.dim(`[${block.language}]`)] : []), ...block.lines]) {
        const segments = wrapCodeLine(codeLine, Math.max(1, width - terminalCellWidth(structural) - 2));
        for (const [segmentIndex, segment] of segments.entries()) {
          const continuation = segmentIndex ? chalk.dim('↳ ') : '  ';
          rows.push(`${linePrefix()}${structural}${continuation}${chalk.cyan(segment)}`);
        }
      }
      continue;
    }
    if (block.kind === 'table') {
      const available = Math.max(1, width - terminalCellWidth(quotePrefix));
      for (const tableLine of renderTableBlock(block.header, block.rows, available, block.align)) {
        rows.push(`${linePrefix()}${quotePrefix}${tableLine}`);
      }
      continue;
    }
    if (block.kind === 'rule') {
      const available = Math.max(1, width - terminalCellWidth(quotePrefix));
      rows.push(`${linePrefix()}${quotePrefix}${chalk.dim('─'.repeat(available))}`);
      continue;
    }
    const listPrefix = block.kind === 'list-item'
      ? `${'  '.repeat(block.depth)}${block.task ? chalk.cyan(block.checked ? '☑' : '☐') : block.ordered ? chalk.dim(`${block.number}.`) : chalk.dim('•')} `
      : block.kind === 'paragraph' ? '  '.repeat(block.indent) : '';
    const structural = `${quotePrefix}${listPrefix}`;
    const hangIndent = ' '.repeat(terminalCellWidth(structural));
    const text = block.kind === 'heading' || block.kind === 'paragraph' || block.kind === 'list-item' ? block.text : '';
    // The block still receiving tokens has a new text on every frame; the
    // streaming renderer keeps an unterminated span from reflowing later.
    const styled = (streaming ? renderInlineMarkdownLive : renderInlineMarkdown)(text || ' ');
    const budget = Math.max(1, width - terminalCellWidth(structural));
    for (const [lineIndex, line] of wrapWords(styled, budget).entries()) {
      const indentation = lineIndex === 0 ? structural : hangIndent;
      rows.push(`${linePrefix()}${indentation}${block.kind === 'heading'
        ? block.level <= 2 ? chalk.cyanBright(chalk.bold(line)) : chalk.bold(line)
        : line}`);
    }
  }
  return rows;
}

export class TerminalHarnessPrompter implements HarnessPrompter {
  private closed = false;
  private history: string[] = [];
  private currentSession?: HarnessSession;
  private currentAccount?: string;
  private currentNotice?: string;
  private draft = '';
  private draftOptions: readonly PickerOption<string>[] = [];
  private draftSelected = 0;
  private draftPrompt = '› ';
  private draftCursor = 0;
  private draftPalette?: { capacity?: number; hint?: string; hideCursor?: boolean };
  private waitingTimer?: NodeJS.Timeout;
  private stopWaitingInput?: () => void;
  private waitingFrame = 0;
  private waitingLabel = '';
  private waitingStartedAt = 0;
  private activityEntries: ActivityEntry[] = [];
  private activeTools = new Map<string, { label: string; category?: ToolCategory }>();
  /** Category of the tool the waiting band is currently reporting, so the
   * spinner is tinted by what is actually happening. */
  private waitingCategory?: ToolCategory;
  private liveResponse = '';
  private responsePaintTimer?: NodeJS.Timeout;
  private frameInFlight = false;
  private queuedDraft?: string;
  private waitingDraft = '';
  private waitingCursor = 0;
  private waitingSubmit?: (text: string) => Promise<LiveTurnInputResult>;
  private waitingSubmissions: Array<{ localId: number; text: string; responseOffset: number; sequence: number; state: 'sending' | 'queued' | 'steered' | 'error' }> = [];
  private waitingSubmissionId = 0;
  private timelineSequence = 0;
  private readonly waitingSubmissionWrites = new Set<Promise<void>>();
  private suspended = false;
  private readonly reducedMotion = reducedMotion();
  private activityAnchor = 0;
  /** Everything this UI writes goes through one append-only stream: finished
   * rows into native scrollback, one small live region below them. */
  private pendingFinished: string[] = [];
  private pendingLive?: { live: string[]; cursorRow: number; cursorColumn: number; hideCursor: boolean };
  /** The last row retired, so a blank separator is never doubled across the
   * boundary between one frame and the next. */
  private lastFinishedRow?: string;
  /** The row before it, so the guard that separates messages can tell one
   * empty row from two across a frame boundary. */
  private secondLastFinishedRow?: string;
  /** Persisted messages already in scrollback, and the standalone activity
   * rows already written. Everything before `emittedMessages` belongs to the
   * terminal now; this UI never addresses it again. */
  private emittedMessages = 0;
  /** `role:content` of the last message written to the transcript -- the seam
   * the next frame carries on from, which a count cannot identify once the
   * caller hands a window of the conversation rather than all of it. */
  private lastEmittedMessage?: string;
  /** Sequence numbers of the standalone activity rows already retired. One
   * number per activity event, alongside activityEntries itself, which is
   * deliberately never evicted -- some of it is immutable scrollback. */
  private readonly emittedActivity = new Set<number>();
  /** User text already retired, so a steer materialized into the transcript by
   * an earlier frame is not drawn a second time as a live row. */
  private readonly retiredThisSession = new Set<string>();
  /** Where the answer currently streaming will land once it is persisted, so
   * the persisted copy adds only what the stream had not already retired. */
  private liveAssistantIndex?: number;
  private readonly turnTranscript = new TurnTranscript();
  /** Timeline sequence this turn started at, so activity left over from an
   * earlier turn at the same anchor is never adopted into it. */
  private turnSequenceFloor = 0;
  /** Write the windowed history once: the first frame of the process, and the
   * first frame of a newly opened session. */
  private reseedTranscript: false | 'first' | 'scroll-away' = 'first';
  private lastColumns = output.columns || 0;
  private usageLabel?: string;
  private usageResetLabel?: string;
  private selecting = false;
  /** True while the slash palette (inside question()) has its own fixed-capacity
   * footer band open. usage()/activity() are called from fire-and-forget async
   * work (a background usage refresh, a turn's tool-call log) that has no idea
   * the palette owns a specific row layout right now; an unguarded repaint from
   * either recomputes capacity from whatever draftOptions happens to be, which
   * doesn't match the palette's own fixed capacity — the two disagree on where
   * the footer starts, and the status line gets drawn at both rows. Guarded the
   * same way `selecting` already guards this for select() pickers. */
  private paletteActive = false;
  private cancelWaiting?: (restoreDraft: boolean) => void;
  private waitingCancelled = false;
  private pendingApproval?: ApprovalRequest & { shownAt: number; needsFocus: boolean; focused: boolean };
  private approvalGuardTimer?: NodeJS.Timeout;
  /** A short-lived hint (the Ctrl+C exit warning) that takes the notice row. */
  private transientNotice?: string;
  private transientNoticeTimer?: NodeJS.Timeout;
  private turnUsage?: { inputTokens?: number; outputTokens?: number };
  private latestThought?: string;
  private panelState?: { title: string; lines: string[]; offset: number; page: number; total: number };
  private planEntries: readonly PlanEntry[] = [];
  private streamingBlocks = createStreamingBlockParser();
  /** Re-installs the key listener and raw mode after Ctrl+Z / `fg`. */
  private resumeInput?: () => void;
  /** Providers fan out parallel tool calls, so a second request can arrive
   * while the first is still on screen. Queueing asks them one at a time;
   * resolving the extras false meant silently denying a tool the user was
   * never shown. */
  private approvalQueue: ApprovalRequest[] = [];
  private approvalRestoreLabel?: string;
  private readonly onWaitingKey = (key: string): void => {
    // Before approvals and before the draft: a turn running is when someone
    // wants to read what went past, and Escape still means interrupt here.
    if (!this.pendingApproval && this.handleScrollKey(key)) return;
    if (this.pendingApproval) {
      // The draft is never edited from here: every key is either an answer or
      // dropped, so the composer is exactly as the user left it afterwards.
      const pending = this.pendingApproval;
      const action = approvalKeyAction(key, Date.now() - pending.shownAt, pending.needsFocus, pending.focused);
      if (action === 'focus') {
        pending.focused = true;
        this.updateWaiting();
      } else if (action === 'allow' || action === 'deny') {
        this.pendingApproval = undefined;
        pending.resolve(action === 'allow');
        if (!this.presentNextApproval()) {
          this.waitingLabel = this.approvalRestoreLabel || 'thinking';
          this.approvalRestoreLabel = undefined;
          this.updateWaiting();
        }
      }
      return;
    }
    const action = waitingInputAction(key);
    if (action === 'cancel-edit' || action === 'cancel-stop') {
      if (this.waitingCancelled) return;
      this.waitingCancelled = true;
      this.waitingLabel = 'stopping…';
      this.updateWaiting();
      this.cancelWaiting?.(action === 'cancel-edit');
    } else if (key === '\u001a') {
      this.suspendToShell();
    } else if (key === '\r') {
      const continued = this.waitingSubmit ? backslashNewline(this.waitingDraft, this.waitingCursor) : undefined;
      if (continued) {
        this.waitingDraft = continued.value;
        this.waitingCursor = continued.cursor;
        this.updateWaiting();
        return;
      }
      const text = this.waitingDraft.trim();
      if (!text || !this.waitingSubmit) return;
      this.waitingDraft = '';
      this.waitingCursor = 0;
      const localId = ++this.waitingSubmissionId;
      this.waitingSubmissions.push({
        localId, text, responseOffset: this.liveResponse.length, sequence: ++this.timelineSequence, state: 'sending',
      });
      this.updateWaiting();
      const write = this.waitingSubmit(text).then((result) => {
        const item = this.waitingSubmissions.find((entry) => entry.localId === localId);
        if (item) item.state = result.disposition;
        this.updateWaiting();
      }).catch(() => {
        const item = this.waitingSubmissions.find((entry) => entry.localId === localId);
        if (item) item.state = 'error';
        if (!this.waitingDraft) {
          this.waitingDraft = text;
          this.waitingCursor = text.length;
        }
        this.queuedDraft = this.queuedDraft ? `${this.queuedDraft}\n${text}` : text;
        this.updateWaiting();
      });
      this.waitingSubmissionWrites.add(write);
      void write.finally(() => this.waitingSubmissionWrites.delete(write));
    } else if (this.waitingSubmit) {
      const edited = editWaitingComposer(this.waitingDraft, this.waitingCursor, key);
      if (edited.changed) {
        this.waitingDraft = edited.value;
        this.waitingCursor = edited.cursor;
        this.updateWaiting();
      }
    }
  };
  private readonly onResize = (): void => {
    if (!this.closed) {
      // A resize invalidates the wrapping of the live region only. Rows already
      // in scrollback keep the wrapping they were written with -- exactly as
      // Ink and ratatui behave, and precisely why neither of them re-dumps the
      // transcript on every resize. The live region is redrawn at the new width
      // by the ordinary frame below.
      //
      // The one thing this cannot prove: the region is erased by walking up
      // the number of rows it was written as, and a terminal that reflows on
      // resize (xterm and iTerm do; tmux does not) may since have turned a row
      // wider than the new width into two. Walking up too few rows leaves a
      // stale row above the composer until the region next changes height;
      // walking up more than were written would erase real scrollback. The
      // cosmetic failure is the one to prefer, so the walk is capped at what
      // was written and never guessed upward. Both reference implementations
      // have this same limit, for this same reason.
      this.lastColumns = output.columns || 0;
      this.forgetScreenPosition();
      logCursorEvent(`resize screen=${output.columns}x${output.rows} raw=${terminalModes.rawMode} alternate=${this.alternateScreen}`);
      // Re-asked here, immediately, before anything is drawn. This is the
      // whole fix for "a swipe scrolls with the keyboard up but not with it
      // hidden": hiding the keyboard resizes the pty, the client reapplies
      // its own defaults across that resize and drops mouse reporting, and
      // nothing turns it back on. A working client's own byte stream shows
      // the same four modes going out after every single resize:
      //
      //     [[resize 63x70]] ?1000h ?1002h ?1003h ?1006h  ?25l ESC[2J ESC[H
      //
      // Idempotent, so a client that never dropped them just sets what is
      // already set.
      if (this.alternateScreen && !SELECTION_MODE.active) output.write(ENABLE_MOUSE_TRACKING);
      // No height probe here: it jumps the cursor to the bottom-right corner
      // and asks, at exactly the moment a swipe is being recognised. The size
      // the terminal announces is what the layout uses.
      this.repaintAfterResize();
    }
  };


  /** Never taller than the screen actually is: a live region that overflows
   * makes the walk back up to the composer clamp at the top edge, which is
   * what parks the cursor on the status line and strands rows below it. The
   * announced size is the ceiling -- a terminal that answers with more rows
   * than it announced is not offering rows we may use. */
  private viewportRows(): number {
    return Math.max(5, output.rows || 30);
  }

  /** The repaint a resize needs, once the resize is over.
   *
   * A keyboard sliding away is not one SIGWINCH, it is a burst of them -- the
   * session log has 70x55, 70x63, 70x40, 70x32 inside four hundred
   * milliseconds -- and painting per signal sent a full-screen repaint for
   * each. At 63 rows of styled transcript that is 4KB a piece, several of them
   * inside the moment the client is dismissing its keyboard and rebuilding the
   * view it decides gestures against.
   *
   * That collision is measured, not guessed. In one session, seven swipes with
   * the keyboard hidden delivered nothing at all; the eighth, with a
   * diagnostic that made every write slower, delivered wheel reports normally.
   * The same swipe works through a recording pty (which delays writes) and in
   * a bare script whose repaint is a tenth the size. Everything that slows or
   * shrinks this write makes the gesture arrive.
   *
   * So the burst is coalesced into the one repaint it always meant, drawn once
   * the size has stopped changing. Short enough not to be seen, long enough to
   * land after the client has finished. */
  private resizePaintTimer?: NodeJS.Timeout;
  private repaintAfterResize(): void {
    if (this.resizePaintTimer) clearTimeout(this.resizePaintTimer);
    this.resizePaintTimer = setTimeout(() => {
      this.resizePaintTimer = undefined;
      if (this.closed || this.suspended) return;
      this.paint(this.draft, this.draftOptions, this.draftSelected, this.draftPrompt, this.draftCursor, this.draftPalette);
    }, RESIZE_SETTLE_MS);
    this.resizePaintTimer.unref();
  }







  /** Rows retired out of the viewport, kept so the conversation above the
   * live region is still there to scroll back to on the alternate screen. */
  private readonly alternateTranscript: string[] = [];
  /** Exactly the rows the last alternate-screen frame left on screen, so the
   * next one writes only what differs. */
  private alternatePrevious: string[] = [];
  /** How many rows above the live region the viewport is held back by. Zero
   * follows the conversation, which is what a transcript does until someone
   * asks to look at what went past. Drawing on the alternate screen took the
   * terminal's own scrollback away; this is what replaces it. */
  private alternateScrollback = 0;
  /** Rows the last frame gave the transcript above the live region. The
   * scroll offset is bounded by it, and it changes with the screen. */
  private alternateAbove = 0;
  /** Which screen this frame belongs on.
   *
   * The conversation lives on the main screen, in a scroll region, because
   * that is the only place the TERMINAL owns the transcript -- and a swipe
   * scrolls what the terminal owns, with no bytes sent, whatever the client
   * is doing with its keyboard.
   *
   * A palette or a picker goes to the alternate screen instead. Two reasons,
   * and they point the same way. It is modal, full-screen, transient UI, which
   * is what that screen is for. And a bottom region cannot grow to fit one
   * without pushing rows off the top of the scrolling half, which the terminal
   * cannot give back -- opening and closing a palette ten times walked the
   * conversation fifty rows away. On the alternate screen it costs nothing:
   * the main screen, transcript and all, is exactly as it was when it closes.
   *
   * On the alternate screen it costs nothing: the screen underneath, the
   * conversation and all, is exactly as it was when the overlay closes. */
  /** Always true in practice: this prompter is only built when stdin and
   * stdout are both TTYs. Kept as a field because close() and suspend() read
   * it to decide whether the screen must be handed back. */
  private readonly alternateScreen = Boolean(output.isTTY);
  /** The title last given to the terminal, so a repaint does not resend it. */

  constructor() {
    terminalModes.uiStarted = true;
    // Stdin is kept flowing for the whole session.
    //
    // Every reader attaches its own `data` listener and removes it again --
    // seven attach/detach cycles a session -- and removing the LAST one puts
    // the stream back into paused mode. So between a prompt ending and the
    // next one opening, stdin was stopped, and anything the client sent in
    // that window sat in the pty buffer instead of being read. The diagnostic
    // UI which does receive the keyboard-hidden swipe on this user's phone
    // never stops reading, and neither does Claude Code.
    //
    // A listener that does nothing is enough: its presence is what keeps the
    // stream flowing. The readers still come and go and still do the work.
    input.on('data', KEEP_STDIN_FLOWING);
    input.resume();
    // Undo whatever the last program left set, before asking for anything.
    // The session before this one may have been closed from the client, in
    // which case its teardown was written into a pty that no longer existed.
    output.write(terminalPrepare());
    if (this.alternateScreen) {
      // Every mode in one breath, with the screen, in this order -- copied
      // from the bare script that receives the gesture on this user's phone
      // when this program does not. Measured minutes apart in the same
      // failing state: that script took 64,214 wheel reports with the
      // keyboard hidden and ClikCode took none, and the opening was the only
      // thing left that differed. It asked for all seven the moment it took
      // the screen; this asked for the four mouse modes and left paste, theme
      // and focus until the first prompt opened, several frames later.
      //
      // The `?1006l` before `?1006h` is the script's, kept deliberately: it
      // makes SGR reporting a transition rather than a no-op, and a client
      // deciding how to route touches has something to notice.
      output.write(ENTER_ALTERNATE_SCREEN);
      terminalModes.alternateScreen = true;
      // Asked for: bracketed paste, because pasted text must not be read as
      // keystrokes, and the mouse, because that is how the transcript is read
      // back. Nothing else.
      //
      // Focus reporting (?1004h) and theme notifications (?2031h) used to be
      // asked for here and then thrown away where keys are read -- neither is
      // acted on anywhere. Asking a phone to send two streams of events that
      // are discarded on arrival is waste at best, and at worst it is more
      // state for a client to hold about a session that is already failing to
      // forward the one gesture that matters. The filters that drop them stay,
      // for a terminal that volunteers them unasked.
      output.write(`${ENABLE_BRACKETED_PASTE}\u001b[?1000h\u001b[?1002h\u001b[?1003h\u001b[?1006l\u001b[?1006h`);
      terminalModes.bracketedPaste = true;
      terminalModes.wheelReporting = true;
    }
    output.write('\u001b[?25h');
    process.on('SIGWINCH', this.onResize);
    // Any exit path -- process.exit() deep in a command, an uncaught error, a
    // signal handler elsewhere -- must not leave the shell in raw mode with a
    // hidden cursor and bracketed paste on.
    process.on('exit', restoreTerminal);
    installTerminalRestoreSignals();
  }

  render(session: HarnessSession, account?: string, notice?: string): void {
    if (this.currentSession?.id !== session.id) {
      this.activityEntries = [];
      this.planEntries = [];
      this.panelState = undefined;
      // The previous conversation is scrolled up into scrollback -- preserved,
      // not erased -- so the new one starts on a clean viewport.
      this.reseedTranscript = this.emittedMessages ? 'scroll-away' : 'first';
    }
    if (!this.waitingLabel) this.waitingSubmissions = [];
    this.currentSession = session;
    this.currentAccount = account;
    this.currentNotice = notice;
    // A render receives authoritative persisted state. Drop the transient
    // stream so the just-saved assistant message is never painted twice.
    if (this.responsePaintTimer) clearTimeout(this.responsePaintTimer);
    this.responsePaintTimer = undefined;
    this.liveResponse = '';
    this.paint('', [], 0, '› ', 0);
  }

  response(text: string, mode: 'append' | 'replace' = 'append'): void {
    // An empty replacement is meaningful when a failed streaming attempt is
    // about to retry on another account. Appends with no content remain a
    // no-op, but replace must clear the obsolete partial response.
    if (!text && mode === 'append') return;
    // The thought led to this text; once the answer is arriving it is stale.
    if (text) this.latestThought = undefined;
    if (mode === 'replace') {
      this.activityEntries = rebaseActivityOffsets(this.activityEntries, this.activityAnchor, this.liveResponse, text);
      this.liveResponse = text;
    } else this.liveResponse += text;
    this.schedulePaint();
  }

  activity(message: string): void {
    const normalized = sanitizeTerminalText(message, { keepSgr: true, singleLine: true }).trim();
    const last = this.activityEntries[this.activityEntries.length - 1];
    if (!normalized || last?.lines[last.lines.length - 1] === normalized) return;
    this.activityEntries = [...this.activityEntries, {
      anchor: this.waitingLabel ? this.activityAnchor : this.currentSession ? sessionTranscriptMessages(this.currentSession).length : 0,
      ...(this.waitingLabel ? { responseOffset: this.liveResponse.length } : {}),
      // Every entry gets one, waiting or not: it is this row's identity for
      // "already retired", and two rows that happen to say the same thing are
      // still two rows.
      sequence: ++this.timelineSequence,
      lines: [normalized],
    }];
    this.schedulePaint();
  }

  /** Optional: the agent's current plan/todo list, shown as a compact block in
   * the live region. Pass an empty list to remove it. */
  setPlan(entries: readonly PlanEntry[]): void {
    this.planEntries = entries.map((entry) => ({ ...entry }));
    this.schedulePaint();
  }

  activityEvent(event: HarnessActivityEvent): void {
    if (event.kind === 'thinking') {
      // Collapsed to the most recent thought, on one live row, never in the
      // transcript. A bare "thinking" label says nothing the spinner does not.
      const thought = sanitizeTerminalText(event.label, { singleLine: true }).replace(/\s+/g, ' ').trim();
      this.latestThought = thought && thought.toLowerCase() !== 'thinking' ? thought : this.latestThought;
    } else if (event.kind === 'tool-start') this.latestThought = undefined;
    const anchor = this.waitingLabel ? this.activityAnchor : this.currentSession ? sessionTranscriptMessages(this.currentSession).length : 0;
    const responseOffset = this.waitingLabel ? this.liveResponse.length : undefined;
    this.activityEntries = upsertActivityEvent(this.activityEntries, anchor, responseOffset, event, ++this.timelineSequence);
    const lifecycle = activityLifecyclePhase(this.activeTools, event);
    this.activeTools = lifecycle.activeTools;
    this.waitingCategory = lifecycle.category;
    this.phase(lifecycle.phase);
    this.schedulePaint();
  }

  /** A scrollable viewer in the live region. It used to keep only the last six
   * lines of the body, which cut /help and capability listings to their tail.
   * The whole body is kept; the prompt scrolls it (Up/Down/PgUp/PgDn while the
   * draft is empty) and q, Esc or Enter closes it. */
  panel(title: string, body: string): void {
    const lines = sanitizeTerminalText(body, { keepSgr: true }).split('\n').map((line) => line.trimEnd());
    while (lines.length && !lines[0]) lines.shift();
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    this.panelState = { title: sanitizeTerminalText(title, { keepSgr: true, singleLine: true }), lines, offset: 0, page: 1, total: lines.length };
    this.paint(this.draft, this.draftOptions, this.draftSelected, this.draftPrompt, this.draftCursor);
  }

  /** True when the key was a panel command. Only consulted on an empty draft,
   * so none of these keys is ever taken away from text being typed. */
  private panelKey(key: string): boolean {
    const panel = this.panelState;
    if (!panel) return false;
    const last = Math.max(0, panel.total - panel.page);
    const scrollTo = (offset: number): boolean => { panel.offset = Math.max(0, Math.min(last, offset)); return true; };
    if (key === '\u001b[A') return scrollTo(panel.offset - 1);
    if (key === '\u001b[B') return scrollTo(panel.offset + 1);
    if (key === '\u001b[5~') return scrollTo(panel.offset - Math.max(1, panel.page - 1));
    if (key === '\u001b[6~' || key === ' ') return scrollTo(panel.offset + Math.max(1, panel.page - 1));
    if (key === 'g') return scrollTo(0);
    if (key === 'G') return scrollTo(last);
    if (key === 'q' || key === 'Q' || key === '\u001b' || key === '\r') { this.panelState = undefined; return true; }
    return false;
  }

  startWaiting(
    message: string,
    onCancel?: (restoreDraft: boolean) => void,
    onSubmit?: (text: string) => Promise<LiveTurnInputResult>,
  ): void {
    this.stopWaiting(false);
    // A new turn is the reader rejoining the conversation.
    this.alternateScrollback = 0;
    this.liveResponse = '';
    // A running turn always renders as stable messages, its submitted user
    // prompt, then one live assistant slot. Keep that slot fixed for the
    // whole turn: deriving it from sessionTranscriptMessages made the anchor
    // grow after the first response delta, so later tools jumped below the
    // assistant reply and appeared to arrive from nowhere.
    // The caller paints the submitted user prompt before entering waiting
    // mode, so the live assistant occupies the next array index exactly.
    // Internal commands that do not display their synthetic prompt also append
    // the transient assistant at this same index.
    this.activityAnchor = this.currentSession?.messages?.length ?? 0;
    this.waitingLabel = message;
    this.cancelWaiting = onCancel;
    this.waitingSubmit = onSubmit;
    this.waitingDraft = '';
    this.waitingCursor = 0;
    this.waitingSubmissions = [];
    this.activeTools.clear();
    this.waitingCategory = undefined;
    this.waitingCancelled = false;
    this.waitingFrame = 0;
    this.waitingStartedAt = Date.now();
    this.turnUsage = undefined;
    this.latestThought = undefined;
    this.panelState = undefined;
    // Whatever the previous turn retired belongs to the terminal now. This one
    // starts owing everything it produces, and nothing from before it.
    this.turnTranscript.reset();
    this.liveAssistantIndex = undefined;
    this.turnSequenceFloor = this.timelineSequence;
    this.streamingBlocks = createStreamingBlockParser();
    if (input.isTTY) {
      const listen = (): void => {
        setTerminalRawMode(true);
        input.resume();
        output.write(enterInputModes());
        this.stopWaitingInput = listenForTerminalKeys(this.onWaitingKey);
      };
      listen();
      this.resumeInput = () => { this.stopWaitingInput?.(); listen(); };
    }
    this.paint('', [], 0, '› ', 0);
    this.waitingTimer = setInterval(() => {
      this.waitingFrame++;
      this.updateWaiting();
    }, this.reducedMotion ? 1000 : 300);
    this.waitingTimer.unref();
  }

  /** The caller uses these only after an interrupted turn: before any output,
   * Escape restores the submitted text; after output begins, the partial turn
   * is persisted instead. */
  restoreDraft(value: string): void { this.queuedDraft = value; }
  async flushWaitingSubmissions(): Promise<void> {
    await Promise.allSettled([...this.waitingSubmissionWrites]);
  }
  liveResponseText(): string { return this.liveResponse; }
  turnOutputStarted(): boolean {
    return Boolean(this.liveResponse || this.activityEntries.some((entry) =>
      entry.anchor === this.activityAnchor && entry.responseOffset !== undefined
      && (entry.event?.kind === 'tool-start' || entry.event?.kind === 'tool-done' || entry.event?.kind === 'tool-error')));
  }

  stopWaiting(refresh = true): void {
    if (this.waitingTimer) clearInterval(this.waitingTimer);
    this.waitingTimer = undefined;
    this.stopWaitingInput?.();
    this.stopWaitingInput = undefined;
    if (this.waitingLabel) this.resumeInput = undefined;
    this.cancelWaiting = undefined;
    this.waitingSubmit = undefined;
    this.waitingCancelled = false;
    this.settleApprovals();
    this.waitingLabel = '';
    this.latestThought = undefined;
    if (refresh && !this.closed) this.paint(this.draft, this.draftOptions, this.draftSelected, this.draftPrompt, this.draftCursor);
  }

  phase(message: string): void {
    if (!this.waitingLabel || this.waitingCancelled || this.waitingLabel === message) return;
    // The band says "waiting for approval" while one is up; remember the phase
    // for when it is answered instead of replacing that.
    if (this.pendingApproval) { this.approvalRestoreLabel = message; return; }
    this.waitingLabel = message;
    this.updateWaiting();
  }

  approval(title: string, detail?: string, preview?: ApprovalPreview): Promise<boolean> {
    return new Promise((resolveApproval) => {
      if (!this.pendingApproval) this.approvalRestoreLabel = this.waitingLabel;
      this.approvalQueue.push({
        title, ...(detail === undefined ? {} : { detail }), ...(preview === undefined ? {} : { preview }), resolve: resolveApproval,
      });
      if (!this.pendingApproval) this.presentNextApproval();
    });
  }

  /** Returns false when nothing was waiting, so the caller knows to restore
   * the turn's own label instead of leaving a stale prompt on screen. */
  private presentNextApproval(): boolean {
    const next = this.approvalQueue.shift();
    if (!next) return false;
    // Each approval gets its own guard window and its own focus requirement:
    // answering the first of two must not let the same keypress, or the next
    // character of a sentence, answer the second.
    this.pendingApproval = { ...next, shownAt: Date.now(), needsFocus: this.waitingDraft.length > 0, focused: false };
    this.waitingLabel = 'waiting for approval';
    if (this.approvalGuardTimer) clearTimeout(this.approvalGuardTimer);
    // Repaint when the guard lifts so the answer row visibly becomes live.
    this.approvalGuardTimer = setTimeout(() => { this.approvalGuardTimer = undefined; this.updateWaiting(); }, APPROVAL_GUARD_MS);
    this.approvalGuardTimer.unref();
    this.updateWaiting();
    return true;
  }

  /** A turn can end while an approval is on screen. Denying outstanding asks
   * is what releases the provider's own awaiting handler; dropping them left
   * it waiting on a promise that could never settle. */
  private settleApprovals(): void {
    const outstanding = [this.pendingApproval, ...this.approvalQueue];
    if (this.approvalGuardTimer) clearTimeout(this.approvalGuardTimer);
    this.approvalGuardTimer = undefined;
    this.pendingApproval = undefined;
    this.approvalQueue = [];
    this.approvalRestoreLabel = undefined;
    for (const item of outstanding) item?.resolve(false);
  }

  /** Optional: token counts for the turn in flight, shown beside the elapsed
   * time. Cleared by the next startWaiting(). */
  setTurnUsage(usage: { inputTokens?: number; outputTokens?: number }): void {
    this.turnUsage = { ...this.turnUsage, ...usage };
    this.updateWaiting();
  }

  usage(label?: string, resetLabel?: string): void {
    if (this.usageLabel === label && this.usageResetLabel === resetLabel) return;
    this.usageLabel = label;
    this.usageResetLabel = resetLabel;
    this.schedulePaint();
  }

  private statusText(): string {
    const session = this.currentSession;
    if (!session) return '';
    const context = compactPath(session.workspace ?? process.cwd());
    const provider = sessionProviderLabel(session);
    const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
    // What the harness reported running beats what it was asked to run: a
    // session set to `automatic` knows nothing until the vendor answers, and
    // a vendor that substituted a model said so on its own stream.
    const rawModel = harness?.modelArgvPrefix ? session.reported?.model ?? session.model ?? 'automatic' : undefined;
    const model = nativeModelLabel(harness?.command, rawModel);
    const effort = harness && harnessSupportsEffort(harness) ? session.effort : undefined;
    // The title used to share this line with provider/model/directory, which
    // meant a long title truncated whichever of those came after it — the
    // exact information you'd want intact regardless of how long the title
    // is. It gets its own line now (see titleText below).
    return [provider, [model, effort].filter(Boolean).join(' '), context].filter(Boolean).join('  •  ');
  }

  /** The only other place a chat's title ever appeared was a transient line in
   * the /resume picker itself — once you were actually inside a resumed
   * conversation there was nothing on screen confirming which one, so
   * switching looked like it hadn't done anything even when the transcript
   * above had in fact changed. Right-aligned on its own line so it never
   * competes with statusText()'s provider/model/directory for space. */
  private titleText(): string | undefined {
    return this.currentSession?.name || undefined;
  }

  /** Elapsed time alongside the label -- matching a native CLI's own "Cogitated
   * for 5m 31s" style -- so a long turn reads as "still working, N seconds in"
   * rather than the same static label sitting there with no sense of how long
   * it's actually been (only the spinner glyph itself changing periodically). */
  private waitingLine(): string {
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - this.waitingStartedAt) / 1000));
    const elapsed = elapsedSeconds < 60 ? `${elapsedSeconds}s` : `${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s`;
    // "steer or queue" over-promised: only the codex app-server transport can
    // interrupt a running turn, and every other harness silently queues for the
    // next one. The per-submission row below the composer already reports which
    // of the two actually happened, so the invitation just says what is always
    // true and lets the outcome speak for itself.
    const tokens = formatTurnUsage(this.turnUsage);
    const label = `${this.waitingLabel} (${elapsed}${tokens ? ` · ${tokens}` : ''})`
      + `${this.cancelWaiting && !this.pendingApproval ? ' · esc to interrupt' : ''}`
      + `${this.waitingSubmit ? ' · type and press Enter to send' : ''}`;
    // What the agent is doing is essential and stays at full contrast; only the
    // counters and key hints after it are dimmed.
    const split = label.indexOf(' (');
    // One spinner, one motion, for every harness and every tool -- the shape
    // is the standard, the colour is what kind of work is running.
    const spinner = waitingSpinnerGlyph(this.reducedMotion ? 0 : this.waitingFrame);
    const tinted = this.waitingCategory ? TOOL_CATEGORY_STYLE[this.waitingCategory].paint(spinner) : chalk.cyanBright(spinner);
    return `${tinted}  ${label.slice(0, split)}${chalk.dim(label.slice(split))}`;
  }

  private updateWaiting(): void {
    if (!this.waitingLabel || this.closed || this.selecting || this.paletteActive) return;
    this.schedulePaint();
  }

  /** Token deltas, spinner ticks, tool events, phases, and usage refreshes can
   * all arrive in the same few milliseconds. One shared scheduler collapses
   * those signals into a single atomic frame instead of queueing competing
   * terminal writes that briefly expose half-updated cursor/footer state. */
  private schedulePaint(delay = 32): void {
    if (this.responsePaintTimer || this.closed || this.suspended || this.selecting || this.paletteActive) return;
    this.responsePaintTimer = setTimeout(() => {
      this.responsePaintTimer = undefined;
      if (!this.closed && !this.selecting && !this.paletteActive) {
        if (this.waitingLabel) this.paint(this.waitingDraft, [], 0, '› ', this.waitingCursor);
        else this.paint(this.draft, this.draftOptions, this.draftSelected, this.draftPrompt, this.draftCursor, this.draftPalette);
      }
    }, delay);
    this.responsePaintTimer.unref();
  }

  /** Every update is a complete atomic frame. Partial footer/composer paints
   * were smaller, but depended on a particular older frame already being on
   * screen and became invalid when slow terminals dropped intermediate work. */
  private paint(composer: string, options: readonly PickerOption<string>[], selected: number, prompt: string, cursor: number, palette?: { capacity?: number; hint?: string; hideCursor?: boolean }): void {
    const session = this.currentSession;
    if (!session || this.suspended) return;
    if (this.responsePaintTimer) clearTimeout(this.responsePaintTimer);
    this.responsePaintTimer = undefined;
    this.draft = composer;
    this.draftOptions = options;
    this.draftSelected = selected;
    this.draftPrompt = prompt;
    this.draftCursor = cursor;
    this.draftPalette = palette ? { capacity: palette.capacity, hint: palette.hint, hideCursor: palette.hideCursor } : undefined;
    // The last column is never printed in. DEC autowrap is off for this whole
    // frame (the `\u001b[?7l` at the top of it), which makes filling it safe
    // on a terminal that honours that -- but several mobile SSH clients, and
    // anything that filters the mode out in between, wrap eagerly instead and
    // turn a full-width row into two. Every motion in a frame is relative, so
    // each such row put the walk back up to the composer one row out, which is
    // what parked the cursor on the status line below the composer instead of
    // in it. Costing one column is a far better trade than that.
    const width = Math.max(12, output.columns || 100);
    const rowWidth = width - 1;
    const inner = width - 4;
    // The conversation transcript gets its own, tighter margin: a bare
    // marker-and-space (2 columns) instead of inner's extra 2-space wrapper
    // on top of its own 4-column reservation (6 total) -- next to a native
    // CLI's own output, which runs close to the full terminal width with
    // only a bullet-and-space margin, ClikCode's wider gutter read as
    // noticeably narrower and "bleaker" for no real reason; this doesn't
    // touch inner itself, so the notice/composer/meta lines below (which
    // share it) are unaffected.
    const conversationInner = rowWidth - 2;
    const rule = chalk.dim('─'.repeat(rowWidth));
    const stableMessages = session.messages ?? [];
    const pending = this.waitingLabel ? session.pendingTurn : undefined;
    const persistedMessages = pending
      ? [...stableMessages, { role: 'user' as const, content: pending.prompt }]
      : sessionTranscriptMessages(session);
    // Tool events often arrive before the first prose token. They still belong
    // to the in-flight assistant message. Render an empty temporary assistant
    // anchor immediately; otherwise the tools remain invisible and then all
    // appear at once when the first sentence arrives.
    const hasTransientAssistant = transientAssistantRequired(
      this.liveResponse, Boolean(this.waitingLabel), persistedMessages.length, this.activityEntries,
    ) || Boolean(pending?.steers?.length);
    const storedQueued = session.queuedTurns ?? [];
    // A queued message has two sources and they overlap. It is drawn live the
    // moment it is typed (waitingSubmissions), and the loop then writes it
    // into the session (queuedTurns) -- so between the write landing and the
    // turn consuming it, both hold the same message and it was drawn twice.
    // The stored copy wins, being the one that survives this process. Steers
    // are deduplicated against their durable copy the same way, just below.
    const storedQueuedTexts = new Set(storedQueued.map((item) => item.text));
    const queuedMessages = [
      ...storedQueued.map((item) => ({ role: 'user' as const, content: item.text, queueState: 'queued' as const })),
      ...this.waitingSubmissions.filter((item) => item.state !== 'steered' && !storedQueuedTexts.has(item.text))
        .map((item) => ({ role: 'user' as const, content: item.text, queueState: item.state })),
    ];
    // The final status row is written without a trailing newline, so using
    // the complete terminal height is safe and important: leaving one row
    // unpainted allowed an obsolete status line to remain visibly duplicated.
    const targetHeight = this.viewportRows();
    const requestedPaletteCapacity = palette?.capacity ?? (options.length ? Math.min(options.length, 8) + 2 : 0);
    // Keep generation at the response's live edge, directly above the
    // composer. It is a fixed status band, not transcript content, so a long
    // streamed answer cannot scroll it away. Optional bands share only the
    // rows left after one composer row and its three fixed footer rows.
    // Two rows: the generating line, and one blank above it so the text still
    // being written is not flush against the spinner. Counted here because
    // this number is the height budget -- reserve one row for a band that
    // draws two and the last line of the answer is pushed off the screen.
    const waitingRows = this.waitingLabel && targetHeight >= 5 ? 2 : 0;
    let optionalRows = Math.max(0, targetHeight - 4 - waitingRows);
    const notice = this.transientNotice ?? this.currentNotice;
    const noticeRows = notice && optionalRows > 0 ? 1 : 0;
    optionalRows -= noticeRows;
    const availablePaletteRows = Math.min(requestedPaletteCapacity, optionalRows);
    const paletteCapacity = availablePaletteRows >= 3 ? availablePaletteRows : 0;
    const paletteRows = paletteCapacity;
    const composerWidth = Math.max(8, inner - terminalCellWidth(prompt));
    // The software keyboard can make a mobile SSH viewport dramatically
    // shorter between two keystrokes. Bound the composer by what remains in
    // this exact frame so it can never create a physical terminal scroll.
    const approval = this.pendingApproval;
    const approvalRows = approval && optionalRows - paletteRows >= 2
      ? approvalBlockRows(approval, width, Math.min(optionalRows - paletteRows, Math.max(6, Math.floor(targetHeight * 0.6))), {
        guarded: Date.now() - approval.shownAt < APPROVAL_GUARD_MS,
        needsFocus: approval.needsFocus, focused: approval.focused, queued: this.approvalQueue.length,
      })
      : [];
    let liveBandBudget = Math.max(0, optionalRows - paletteRows - approvalRows.length - 2);
    const thoughtRows = this.waitingLabel && this.latestThought && !approval && liveBandBudget > 0
      ? [`  ${chalk.dim(chalk.italic(visibleSlice(`✻ ${this.latestThought}`, Math.max(1, inner))))}`] : [];
    liveBandBudget -= thoughtRows.length;
    const planRows = paletteRows || this.selecting ? [] : planBlockRows(this.planEntries, width, liveBandBudget);
    liveBandBudget -= planRows.length;
    const panelRows: string[] = [];
    const panel = this.panelState;
    if (panel && !paletteRows && !approval && !this.selecting && liveBandBudget >= 3) {
      const wrapped = panel.lines.flatMap((line) => (terminalCellWidth(line) <= inner ? [line] : wrapCodeLine(line, inner)));
      const page = Math.max(1, Math.min(wrapped.length, liveBandBudget - 2, Math.max(3, targetHeight - 10)));
      panel.page = page;
      panel.total = wrapped.length;
      panel.offset = Math.max(0, Math.min(panel.offset, wrapped.length - page));
      const scrollable = wrapped.length > page;
      const position = scrollable ? `${panel.offset + 1}-${panel.offset + page} of ${wrapped.length} · ↑↓ PgUp/PgDn scroll · ` : '';
      panelRows.push(
        `  ${chalk.bold(visibleSlice(panel.title, inner))}`,
        ...wrapped.slice(panel.offset, panel.offset + page).map((line) => `  ${line}`),
        `  ${chalk.dim(visibleSlice(`${position}q/Esc/Enter close`, inner))}`,
      );
    }
    const maxComposerRows = Math.max(
      1, targetHeight - 3 - paletteRows - noticeRows - waitingRows - approvalRows.length - thoughtRows.length - planRows.length - panelRows.length,
    );
    const composerRows = composerLayout(composer, cursor, composerWidth, maxComposerRows);
    // -------------------------------------------------------------------
    // The append-only transcript. A finished row is handed to the terminal's
    // own scrollback exactly once and is never addressed again; only the live
    // region below it -- the block still receiving tokens, queued turns and
    // the footer -- is erased and redrawn. Nothing here rebuilds the
    // conversation to work out which prefix is safe to promote. TurnTranscript
    // decides what can no longer change, and that is the whole decision.
    // -------------------------------------------------------------------
    const finished: string[] = [];
    const emit = (rows: readonly string[]): void => {
      for (const row of rows) {
        const last = finished.length ? finished[finished.length - 1] : this.lastFinishedRow;
        const before = finished.length > 1 ? finished[finished.length - 2]
          : finished.length ? this.lastFinishedRow : this.secondLastFinishedRow;
        // An empty row on each side of a message, so two of them separate a
        // message from the answer under it and from the message after it.
        // Never a third, and never a leading one at the top of a transcript.
        if (row === '' && (last === undefined || (last === '' && (before === '' || before === undefined)))) continue;
        finished.push(row);
      }
    };
    const userMarker = chalk.bold('›');
    // No marker in front of a tool row. The bullet was there to carry the
    // category colour, and it cost a glyph on every line of every call --
    // including each line of captured output, which made a transcript of
    // real work read as a column of dots. The label already says `Bash(...)`
    // and carries the colour itself; the spinner in the waiting band is
    // where the category still shows while a call runs.
    const activityRows = (lines: readonly string[], category?: ToolCategory): string[] => (lines.length
      ? ['', ...lines.map((line, index) => {
        const text = visibleSlice(line, Math.max(1, conversationInner - 2));
        return `  ${index === 0 && category ? TOOL_CATEGORY_STYLE[category].paint(text) : text}`;
      }), '']
      : []);
    const messageRows = (content: string, marker: string): string[] =>
      renderMessageBlocks(splitIntoBlocks(sanitizeTerminalText(content)), marker, conversationInner);
    /** Activity that belongs between two messages rather than inside a turn.
     * Retired once, by identity rather than by text -- two rows that say the
     * same thing are still two rows -- and an entry that arrives after its
     * anchor has been passed is appended where it lands, which is the only
     * thing an append-only transcript can do with it. */
    const standaloneActivity = (anchor: number): string[] => {
      const rows: string[] = [];
      for (const entry of this.activityEntries) {
        if (entry.anchor !== anchor || entry.responseOffset !== undefined) continue;
        const id = entry.sequence;
        if (id === undefined || this.emittedActivity.has(id)) continue;
        this.emittedActivity.add(id);
        rows.push(...activityRows(entry.lines, entry.event?.category));
      }
      return rows;
    };
    /** The in-flight turn's tools and steering messages, as rows that settle.
     * A running tool is reported in the waiting band ("running <label>") and
     * nowhere else: its row is still mutable -- completion rewrites it with the
     * output preview -- and a mutable row can never enter scrollback. At the
     * end of the turn a tool that never reported completion settles anyway,
     * rather than being lost or holding the region open forever. */
    const turnTools = (ended: boolean): SettlingTool[] => {
      const tools: SettlingTool[] = this.activityEntries
        // An anchor is reused: the next turn's assistant occupies the same
        // index when the previous one was never persisted. The turn that
        // produced an entry is what decides whether it belongs to this one.
        .filter((entry) => entry.anchor === this.activityAnchor && entry.responseOffset !== undefined
          && (entry.sequence ?? 0) > this.turnSequenceFloor)
        .filter((entry) => ended || entry.event?.kind !== 'tool-start')
        .map((entry) => ({
          id: entry.event?.id ?? `activity#${entry.sequence ?? entry.responseOffset}`,
          done: true, responseOffset: entry.responseOffset, lines: activityRows(entry.lines, entry.event?.category),
        }));
      // One row on each side, matching every other message: a steer is a
      // message the user wrote mid-answer.
      const steerRows = (text: string): string[] => [
        '', ...messageRows(text, userMarker), `  ${chalk.dim('↳ steered into active turn')}`, '',
      ];
      // A steer is drawn live, and sessionTranscriptMessages() also
      // materializes it as a real user message; only one of the two may reach
      // the transcript.
      const durable = materializedPendingTurn ? [] : pending?.steers ?? [];
      tools.push(...durable.map((item, index) => ({
        id: `steer#${item.responseOffset ?? 0}#${index}`, done: true,
        responseOffset: item.responseOffset ?? 0, lines: steerRows(item.text),
      })));
      const durableTexts = new Set(durable.map((item) => item.text));
      tools.push(...this.waitingSubmissions
        .filter((item) => item.state === 'steered' && !durableTexts.has(item.text)
          && !(materializedPendingTurn && this.retiredThisSession.has(item.text)))
        .map((item) => ({
          id: `steer#${item.sequence}`, done: true, responseOffset: item.responseOffset, lines: steerRows(item.text),
        })));
      return tools;
    };
    const renderBlocks = (blocks: readonly MessageBlock[], firstOfMessage: boolean): string[] =>
      renderMessageBlocks(blocks, '·', conversationInner, firstOfMessage);
    const renderLive = (blocks: readonly MessageBlock[], firstOfMessage: boolean): string[] =>
      renderMessageBlocks(blocks, '·', conversationInner, firstOfMessage, true);

    if (this.reseedTranscript === 'scroll-away') {
      finished.push(...Array.from({ length: targetHeight }, () => ''));
      this.lastFinishedRow = '';
    }
    if (this.reseedTranscript) {
      // The first frame of the process, or of a newly opened session, writes
      // the conversation once -- ALL of it. Everything already in scrollback
      // (the shell's own output, the previous conversation) stays where it is.
      //
      // This wrote only the last forty messages, which is why a chat opened
      // from disk could not be scrolled back through: the rows were never
      // written, so there was nothing above the fold to find. On the main
      // screen the terminal's scrollback is where a conversation lives, and a
      // window here truncated it at the one moment it is filled.
      this.emittedMessages = 0;
      this.lastEmittedMessage = undefined;
      this.emittedActivity.clear();
      this.retiredThisSession.clear();
      this.liveAssistantIndex = undefined;
      this.turnTranscript.reset();
      this.reseedTranscript = false;
    }
    // Where this list carries on from what has already been written.
    //
    // A count alone cannot answer that: the interactive loop hands the turn's
    // own view of the conversation as `messages.slice(-40)`, so the array that
    // arrives mid-turn is a WINDOW, not the whole transcript. Counting
    // absolutely, a long conversation had already emitted more messages than
    // the window contains, so the loop below started past its end and wrote
    // nothing -- the message the user had just submitted included. It vanished
    // as the answer to it streamed in underneath.
    //
    // The last message actually written identifies the seam wherever it sits,
    // window or not. Searching from the end keeps a repeated sentence from
    // rewinding the transcript to its first occurrence.
    const messageKey = (message: { role: string; content: string }): string => `${message.role}:${message.content}`;
    let firstUnwritten = Math.min(this.emittedMessages, persistedMessages.length);
    if (this.lastEmittedMessage !== undefined) {
      for (let index = persistedMessages.length - 1; index >= 0; index -= 1) {
        if (messageKey(persistedMessages[index]!) === this.lastEmittedMessage) { firstUnwritten = index + 1; break; }
      }
    }
    // More messages were retired than this turn's own list has, and none of
    // them is the seam, which is what a pending turn already materialized into
    // the transcript looks like from here: its steers are in scrollback as
    // real user messages, and scrollback cannot be unwritten, so the live
    // copies of them are the ones to drop.
    const materializedPendingTurn = firstUnwritten >= persistedMessages.length
      && this.emittedMessages > persistedMessages.length;
    // Where the live answer actually landed, which is not always where it was
    // expected to.
    //
    // While the answer streams, its index is recorded as the length of the
    // list at that moment. By the time the turn is persisted the user's own
    // message may have been materialized into that same list -- it is not
    // always echoed into the pre-turn render -- which shifts the assistant
    // down by one. The recorded index then points at the USER message, the
    // role check below fails, and the answer is emitted a second time
    // underneath the copy already on screen: the transcript jumps a screen and
    // the same response is sitting there again.
    //
    // A turn ends with its assistant message, so the first assistant at or
    // after the recorded index is the one that was streamed.
    let liveAssistant = this.liveAssistantIndex;
    while (liveAssistant !== undefined && liveAssistant < persistedMessages.length
      && persistedMessages[liveAssistant]!.role !== 'assistant') liveAssistant += 1;

    emit(standaloneActivity(firstUnwritten));
    for (let index = firstUnwritten; index < persistedMessages.length; index += 1) {
      const message = persistedMessages[index]!;
      if (index === liveAssistant && message.role === 'assistant') {
        // The answer that just streamed. Its rows are already in scrollback and
        // the transcript knows exactly which blocks it still owes, so a
        // persisted copy that runs longer than what streamed -- a re-derived
        // answer, an interrupted turn -- contributes only its tail, and one
        // identical to what streamed contributes nothing at all.
        emit(this.turnTranscript.advance({
          content: sanitizeTerminalText(message.content), tools: turnTools(true), turnEnded: true, renderBlocks,
        }).finished);
      } else {
        emit(messageRows(message.content, message.role === 'assistant' ? '·' : userMarker));
        if (message.role === 'user') this.retiredThisSession.add(message.content);
      }
      if (index === liveAssistant) {
        this.liveAssistantIndex = undefined;
        liveAssistant = undefined;
        this.turnTranscript.reset();
      }
      this.lastEmittedMessage = messageKey(message);
      emit(['']);
      emit(standaloneActivity(index + 1));
    }
    // Monotonic: a row in scrollback cannot be un-emitted, so a list that
    // comes back shorter -- sessionTranscriptMessages() materializes a pending
    // turn, the live form of the same turn does not -- must not lower this.
    this.emittedMessages = Math.max(this.emittedMessages, persistedMessages.length);

    const liveConversation: string[] = [];
    if (hasTransientAssistant) {
      this.liveAssistantIndex = persistedMessages.length;
      const content = sanitizeTerminalText(this.liveResponse);
      const step = this.turnTranscript.advance({
        content,
        // The live answer is lexed from its last blank-line boundary rather
        // than re-parsed from the top on every delta.
        blocks: this.streamingBlocks(content),
        tools: turnTools(!this.waitingLabel),
        turnEnded: !this.waitingLabel,
        renderBlocks,
        renderLive,
      });
      emit(step.finished);
      liveConversation.push(...step.live);
    }
    for (const message of queuedMessages) {
      // Provisional, and so never retired: a queued turn becomes a real user
      // message the moment it is sent, and would then be written a second time.
      const status = message.queueState === 'steered' ? 'steered into active turn'
        : message.queueState === 'sending' ? 'submitting…'
          : message.queueState === 'error' ? 'not sent · restored for editing' : 'queued for next turn';
      // One row, the same separator the transcript gives every other message:
      // a message submitted mid-turn is still a message the user wrote.
      liveConversation.push('', ...messageRows(message.content, userMarker), `  ${chalk.dim(`↳ ${status}`)}`);
    }
    const conversationLines = liveConversationLines(liveConversation, true);
    const meta = this.statusText();
    const footer: string[] = [];
    if (noticeRows && notice) footer.push(`  ${chalk.yellow(visibleSlice(notice, inner))}`);
    if (paletteCapacity) {
      footer.push(rule);
      const visibleRows = paletteCapacity - 2;
      const windowed = paletteDisplayRows(options as readonly PaletteEntry[], selected, visibleRows);
      for (const row of windowed) {
        if ('header' in row) {
          footer.push(`  ${chalk.dim(visibleSlice(`── ${row.header}`, Math.max(1, width - 4)))}`);
          continue;
        }
        const selectedOption = row.index === selected;
        const available = Math.max(1, width - 4);
        const label = visibleSlice(row.option.label, available);
        let remaining = available - terminalCellWidth(label);
        const argHint = row.option.argHint && remaining > 3 ? visibleSlice(row.option.argHint, remaining - 1) : '';
        remaining -= argHint ? terminalCellWidth(argHint) + 1 : 0;
        const detail = row.option.detail && remaining > 3 ? visibleSlice(row.option.detail, remaining - 2) : '';
        footer.push(`  ${selectedOption ? chalk.cyan('❯') : ' '} ${selectedOption ? chalk.bold(label) : label}${argHint ? ` ${chalk.dim(argHint)}` : ''}${detail ? `  ${chalk.dim(detail)}` : ''}`);
      }
      for (let index = windowed.length; index < visibleRows; index++) footer.push('');
      footer.push(`  ${chalk.dim(visibleSlice(palette?.hint ?? '↑↓ select · Tab complete · Enter run', width - 2))}`);
    }
    footer.push(...panelRows, ...planRows, ...approvalRows, ...thoughtRows);
    if (waitingRows) {
      footer.push('', `  ${visibleSlice(this.waitingLine(), Math.max(1, inner))}`);
    }
    // When a window is exhausted, the harness-reported reset time sits
    // directly above the usage rule it describes.
    if (this.usageResetLabel) {
      footer.push(`  ${chalk.dim(visibleSlice(this.usageResetLabel, Math.max(1, width - 2)))}`);
    }
    // Usage lives on the upper composer border, mirroring the title on the
    // lower border. Keeping it out of the provider/model/directory row makes
    // the two quota windows easy to scan without adding another footer row.
    footer.push(chalk.dim(rightLabeledRule(rowWidth, this.usageLabel)));
    const composerStart = footer.length;
    for (const [index, row] of composerRows.rows.entries()) {
      footer.push(`  ${index === 0 ? chalk.bold(prompt) : ' '.repeat(terminalCellWidth(prompt))}${row}`);
    }
    // The rule below the composer carries the chat's title at its right
    // edge instead of a plain dashed line -- dashes fill from the left up to
    // wherever the title starts, so a longer title just eats more of the
    // rule rather than needing a line of its own. Provider/model/directory
    // (meta) stay on their own separate line below, never sharing space with
    // the title the way they used to.
    footer.push(chalk.dim(rightLabeledRule(rowWidth, this.titleText())));
    footer.push(`  ${chalk.dim(visibleSlice(meta, inner))}`);

    // The live region is bounded by the viewport: it is erased and redrawn as
    // one block every frame, so it can never be taller than the terminal. A
    // construct that settles only when it closes -- a table still receiving
    // rows -- shows its tail until then, and every row of it is written on the
    // frame the block completes.
    const maxLiveConversation = Math.max(0, targetHeight - footer.length);
    const liveConversationRows = Math.min(conversationLines.length, maxLiveConversation);
    const unbounded = [...(maxLiveConversation ? conversationLines.slice(-maxLiveConversation) : []), ...footer];
    // The hard invariant every relative motion in a frame depends on: the
    // live region fits on screen. maxLiveConversation only bounds the
    // conversation half, so a footer taller than the viewport (a palette and
    // an approval block on a short phone screen) would still overflow, and an
    // overflowing block cannot be walked back up -- the terminal stops at its
    // top row and the cursor stays that many rows low. Dropping from the top
    // costs context; not dropping costs a working cursor.
    const overflow = Math.max(0, unbounded.length - targetHeight);
    const live = overflow ? unbounded.slice(overflow) : unbounded;
    // The composer's own row and column, whether or not the frame shows the
    // cursor: see parkCursorAt. The block's last row is the status line, and a
    // caret parked there is the one every report of "the cursor is under the
    // composer" is actually describing.
    const cursorRow = Math.max(0, liveConversationRows + composerStart + composerRows.cursorRow - overflow);
    const cursorColumn = 3 + terminalCellWidth(prompt) + composerRows.cursorWidth;
    this.renderFrame(finished, live, cursorRow, cursorColumn, Boolean(palette?.hideCursor));
  }

  /** One append-only frame. `finished` rows are handed to the terminal's own
   * scrollback -- written once, never addressed again -- and only the live
   * region below them is erased and redrawn. */
  private renderFrame(
    finished: readonly string[], live: readonly string[], cursorRow: number, cursorColumn: number, hideCursor: boolean,
  ): void {
    // Last line of defence: whatever produced a row, the only escape sequences
    // that reach the terminal are SGR colors, no row contains a control
    // character that would move the cursor out from under the live region, and
    // no row reaches the terminal's last column -- a row that fills it wraps
    // into a second one wherever DECAWM-off is not honoured, and every
    // relative motion in the frame after it is then one row out. The layout
    // above already budgets for this; clipping here means a new row builder
    // cannot reintroduce it.
    const limit = Math.max(1, (output.columns || 100) - 1);
    const safeRow = (row: string): string =>
      closeOpenHyperlink(visibleSlice(sanitizeTerminalText(row, { keepSgr: true, singleLine: true }), limit));
    // Frames that coalesce while a write drains accumulate their finished rows
    // instead of replacing them. A live row dropped here is drawn again by the
    // frame that replaces it; a retired row would simply be lost.
    this.pendingFinished.push(...finished.map(safeRow));
    this.pendingLive = { live: live.map(safeRow), cursorRow, cursorColumn, hideCursor };
    if (!this.frameInFlight) this.flushFrame();
  }

  private flushFrame(): void {
    if (this.closed || this.suspended) return;
    const pending = this.pendingLive;
    if (!pending) return;
    this.pendingLive = undefined;
    const finished = this.pendingFinished;
    this.pendingFinished = [];
    if (finished.length) {
      this.secondLastFinishedRow = finished.length > 1 ? finished[finished.length - 2] : this.lastFinishedRow;
      this.lastFinishedRow = finished[finished.length - 1];
    }
    this.flushAlternateFrame(finished, pending);
  }

  /** One screen, every row at an address.
   *
   * Retired rows go into `alternateTranscript` instead of the terminal's
   * scrollback, the viewport shows its tail above the live region, and the
   * cursor is parked with an absolute jump. Nothing here counts rows the
   * terminal might count differently, so nothing here can drift. */
  private flushAlternateFrame(
    finished: readonly string[],
    pending: { live: string[]; cursorRow: number; cursorColumn: number; hideCursor: boolean },
  ): void {
    if (finished.length) {
      this.alternateTranscript.push(...finished);
      // Someone reading stays where they are. The offset counts rows from the
      // end of the transcript, so rows arriving at that end move the window
      // forward by one per row -- the text walks out from under the reader
      // while a turn streams, which is what "scrolling slips through previous
      // messages" is. Growing the offset by the same count holds it still.
      if (this.alternateScrollback > 0) this.alternateScrollback += finished.length;
      // Trimming the front does not move the end, so it leaves the offset be.
      const excess = this.alternateTranscript.length - ALTERNATE_TRANSCRIPT_ROWS;
      if (excess > 0) this.alternateTranscript.splice(0, excess);
    }
    const height = this.viewportRows();
    const live = pending.live.slice(-height);
    const above = Math.max(0, height - live.length);
    this.alternateAbove = above;
    // Scrolled back, the live region gives up its rows to the transcript:
    // looking at what went past is the whole point, and the composer is not
    // what is being read. A frame at offset zero is the conversation as it
    // happens.
    // How far back this screen can actually show, which is not how far back
    // the offset is allowed to go: `above` is the rows the transcript gets,
    // and it grows with the screen. A phone hiding its keyboard hands back a
    // third of the screen at once, so an offset that was inside the range a
    // moment ago is suddenly past its end -- and every further swipe moves a
    // number while the view stays pinned at the top, which reads as scrolling
    // having stopped working. The offset is clamped to what can be shown.
    const furthest = Math.max(0, this.alternateTranscript.length - above);
    this.alternateScrollback = Math.min(this.alternateScrollback, furthest);
    const scrolled = this.alternateScrollback;
    const rows = scrolled > 0
      ? [
        ...this.alternateTranscript.slice(
          Math.max(0, this.alternateTranscript.length - above - scrolled),
          this.alternateTranscript.length - scrolled,
        ),
        ...live.slice(0, Math.max(0, height - above)),
      ]
      : [...this.alternateTranscript.slice(-above), ...live];
    while (rows.length < height) rows.unshift('');
    // Only what changed. A keystroke changes the composer's row and nothing
    // else, and rewriting the whole screen for it costs kilobytes per key on
    // a phone link -- long enough for a client's own prediction popup to
    // appear in the gap before the echo lands. Each row is addressed, so a
    // partial update is exactly as safe as a whole one, which is the point of
    // drawing here. `EL` per row: replaced, never overprinted.
    const full = this.alternatePrevious.length !== rows.length;
    // A scroll is a shift, and the terminal can do a shift itself.
    //
    // Row by row, a scroll changes every row on screen, so the diff below
    // rewrites the whole thing: about 3.3KB at 63 rows against 1.6KB at 32 --
    // and 63 rows is the keyboard-hidden height, the one case that never
    // worked. The same UI drawing ~0.8KB frames receives the gesture at both
    // heights. Cost per frame is the difference, and it scales with the screen.
    //
    // So when the new screen is the old one shifted -- which is exactly what a
    // scroll produces -- the shift is handed to the terminal (SU/SD inside a
    // region covering the transcript) and only the rows it exposed are drawn.
    // Three rows instead of sixty-three.
    //
    // Claude Code never rewrites whole rows either: 4,182 relative motions in
    // one captured session against 347 absolute jumps. This UI had zero.
    // Only a transcript scroll hands the movement to the terminal. Other
    // screens that happen to look shifted -- a palette opening, a picker
    // closing -- are drawn, because SU inside a region discards what it pushes
    // out and those are not rows this code can redraw from its own transcript.
    const scrolling = this.paintingScroll;
    this.paintingScroll = false;
    const shift = full || !scrolling ? 0 : this.scrollShift(rows, above);
    const updates: string[] = [];
    // Rows the shift already drew, so the diff below does not draw them twice
    // -- a frame carrying the same row twice is a duplicated prompt on screen.
    let exposedFrom = -1;
    let exposedTo = -1;
    if (shift !== 0) {
      const span = Math.abs(shift);
      // Region over the transcript only, so the live region stays put; reset
      // straight after, because a region left set confines every later frame.
      updates.push(`\u001b[1;${above}r`);
      updates.push(shift > 0 ? `\u001b[${span}S` : `\u001b[${span}T`);
      updates.push('\u001b[r');
      const exposed = shift > 0 ? rows.slice(above - span, above) : rows.slice(0, span);
      exposedFrom = shift > 0 ? above - span : 0;
      exposedTo = exposedFrom + span;
      for (const [offset, row] of exposed.entries()) {
        updates.push(`\u001b[${exposedFrom + offset + 1};1H${row}\u001b[K`);
      }
    }
    for (const [index, row] of rows.entries()) {
      if (!full && this.alternatePrevious[index] === row) continue;
      if (index >= exposedFrom && index < exposedTo) continue;
      if (shift !== 0 && index < above && this.shiftedRow(index, shift) === row) continue;
      updates.push(`\u001b[${index + 1};1H${row}\u001b[K`);
    }
    this.alternatePrevious = rows;
    const composerRow = rows.length - live.length + pending.cursorRow + 1;
    // Parked whether or not the cursor is shown. DECTCEM is a request, and a
    // client that draws its own caret regardless (phone clients do) puts it
    // wherever this code last left it -- which, unparked, is the end of the
    // block's last row: the status line, under the composer. Only the `?25h`
    // below depends on whether the frame shows it.
    const park = `\u001b[${Math.max(1, Math.min(height, composerRow))};${Math.max(1, pending.cursorColumn)}H`;
    if (!updates.length && !park) return;
    // A frame that redraws everything clears first, and homes, which is what
    // Claude Code does after a resize on this user's phone:
    //
    //     ?1000h ?1002h ?1003h ?1006h  ?25l ESC[2J ESC[H  ...redraw...
    //
    // Addressed rows would overwrite every cell anyway; the clear costs seven
    // bytes and leaves nothing of the old size behind on a screen that just
    // changed shape.
    const clear = full ? '\u001b[2J\u001b[H' : '';
    const frame = `\u001b[?25l${clear}${updates.join('')}${park}${pending.hideCursor ? '' : '\u001b[?25h'}`;
    this.frameInFlight = true;
    terminalModes.painted = true;
    logCursorEvent(`alternate frame: height=${height} rows=${updates.length}/${rows.length} composer=${composerRow} col=${pending.cursorColumn}`);
    output.write(frame, () => {
      this.frameInFlight = false;
      if (this.pendingLive && !this.closed && !this.suspended) this.flushFrame();
    });
  }

  /** How far the previous screen would have to move to become this one, or
   * zero when it is not a clean shift. Positive means content moved up. */
  private scrollShift(rows: readonly string[], above: number): number {
    const previous = this.alternatePrevious;
    // Only the transcript moves. The live region below it is drawn, not
    // scrolled, so a whole-screen comparison never sees a clean shift.
    if (previous.length !== rows.length || above < 4) return 0;
    // Only when the transcript has actually moved. A keystroke changes one
    // row, and a transcript padded with blank rows matches any shift you care
    // to test -- so without this a keystroke looked like a scroll and redrew
    // the screen, which is the opposite of the point.
    let changed = 0;
    for (let index = 0; index < above; index += 1) if (previous[index] !== rows[index]) changed += 1;
    if (changed * 2 < above) return 0;
    for (let shift = 2; shift < above; shift += 1) {
      let up = true;
      let down = true;
      for (let index = 0; index + shift < above; index += 1) {
        if (up && previous[index + shift] !== rows[index]) up = false;
        if (down && previous[index] !== rows[index + shift]) down = false;
        if (!up && !down) break;
      }
      if (up) return shift;
      if (down) return -shift;
    }
    return 0;
  }

  /** What a row would hold after the shift, so the diff below can skip the
   * rows the terminal has already moved into place. */
  private shiftedRow(index: number, shift: number): string | undefined {
    const source = index + shift;
    return source >= 0 && source < this.alternatePrevious.length ? this.alternatePrevious[source] : undefined;
  }



  /** `hidden` keeps the cursor invisible -- it does not mean the cursor may be
   * left anywhere. A terminal always has one, and a client that draws its own
   * caret regardless of DECTCEM (phone SSH clients do) puts it wherever this
   * code last left it. Parking a "hidden" cursor on the block's last row is
   * therefore a caret sitting on the status line, under the composer, for as
   * long as a turn runs. It is parked on the composer either way; only whether
   * it is shown depends on the frame. */
  private parkCursorAt(row: number, column: number, hidden = false): void {
    if (this.closed || this.suspended) return;
    output.write(`\u001b[${Math.max(1, row)};${Math.max(1, column)}H${hidden ? '' : '\u001b[?25h'}`);
  }

  /** Move the viewport through the transcript. Positive scrolls back, and the
   * conversation is followed again at zero, which every new frame returns to
   * by itself once the reader lets go. Returns whether anything moved, so a
   * key that cannot scroll any further still means something to the caller. */
  scrollTranscript(rows: number): boolean {
    if (!this.alternateScreen) return false;
    // Bounded by what the CURRENT screen can show -- see flushAlternateFrame.
    // Bounding it by the transcript's length instead let the offset run past
    // the end of what any frame would draw, and the rows a reader then had to
    // swipe back through before the view moved again were rows that were
    // never on it.
    const furthest = Math.max(0, this.alternateTranscript.length - this.alternateAbove);
    const next = Math.max(0, Math.min(furthest, this.alternateScrollback + rows));
    // What a report of "it did not move" needs to be answerable: whether the
    // key arrived (logged where keys are read), and whether there was anywhere
    // to go -- a screen tall enough to show the whole transcript has nothing
    // hidden above it, and refusing to move is then the right answer.
    logCursorEvent(`scroll by=${rows} from=${this.alternateScrollback} to=${next} furthest=${furthest} rows=${this.alternateTranscript.length} above=${this.alternateAbove}`);
    if (next === this.alternateScrollback) return false;
    this.alternateScrollback = next;
    this.paintingScroll = true;
    this.scheduleScrollPaint();
    return true;
  }

  /** How much of a pending scroll to apply now, carrying the rest.
   *
   * Transcribed from Claude Code's proportional drain, which is what it runs
   * on a terminal that is not xterm.js:
   *
   *     const step = Math.min(height - 1, Math.max(4, |delta| * 3 >> 2));
   *     if (|delta| <= step) return delta;          // small moves land whole
   *     pending = delta - step; return step;        // the rest drains later
   *
   * Three quarters of what is outstanding, never more than a screenful in one
   * frame, and at least four rows so it always finishes. A single notch is
   * three rows and lands whole and at once; a flick of three hundred notches
   * becomes a handful of bounded frames instead of three hundred full
   * repaints, which is what made the client stop forwarding the gesture. */
  private pendingScroll = 0;
  /** True while the frame being drawn is the result of a scroll. */
  private paintingScroll = false;
  private scrollDrainTimer?: NodeJS.Timeout;
  private drainScroll(): void {
    if (this.closed || this.suspended || !this.pendingScroll) return;
    const magnitude = Math.abs(this.pendingScroll);
    const step = Math.min(Math.max(1, this.viewportRows() - 1), Math.max(SCROLL_DRAIN_MIN, (magnitude * 3) >> 2));
    const applied = magnitude <= step ? this.pendingScroll : (this.pendingScroll > 0 ? step : -step);
    this.pendingScroll -= applied;
    const moved = this.scrollTranscript(applied);
    // Nowhere further to go: drop the rest rather than drain against the end.
    if (!moved) this.pendingScroll = 0;
    if (!this.pendingScroll || this.scrollDrainTimer) return;
    this.scrollDrainTimer = setTimeout(() => {
      this.scrollDrainTimer = undefined;
      this.drainScroll();
    }, SCROLL_DRAIN_MS);
    this.scrollDrainTimer.unref();
  }

  /** Wheel notches go here, not straight to the viewport. */
  queueScroll(rows: number): boolean {
    if (!this.alternateScreen) return false;
    this.pendingScroll += rows;
    if (inKeyBatch()) { this.drainAtBatchEnd(); return true; }
    this.drainScroll();
    return true;
  }

  private stopDrainBatch?: () => void;
  private drainAtBatchEnd(): void {
    this.stopDrainBatch ??= onKeyBatchEnd(() => this.drainScroll());
  }

  /** One repaint per burst of wheel notches, not one per notch.
   *
   * A flick on a phone is not a few notches, it is momentum: the client
   * delivers them in bursts of three hundred and more, measured here in single
   * reads of over a thousand. Painting per notch asked the link to carry a
   * full-screen repaint for each -- in a long conversation that is about 4KB a
   * frame, so one flick is upwards of a megabyte, and the client stops
   * forwarding the gesture rather than fall further behind.
   *
   * That is the whole bug, and it is why it depended on the conversation:
   * measured on the device, a fresh chat (246 transcript rows, small frames)
   * took 221 wheel reports with the keyboard hidden, and this conversation
   * (2000 rows, full-width styled frames) took none. The same shape showed up
   * in a bare script -- plain rows 46,048 reports, styled 4KB rows 3,751.
   *
   * The offset is still updated per notch, so nothing is lost and the view
   * lands exactly where the finger left it; only the drawing is coalesced. */
  private scrollPaintQueued = false;
  private stopScrollBatch?: () => void;
  private scheduleScrollPaint(): void {
    const draw = (): void => {
      this.scrollPaintQueued = false;
      if (this.closed || this.suspended) return;
      this.paint(this.draft, this.draftOptions, this.draftSelected, this.draftPrompt, this.draftCursor, this.draftPalette);
    };
    // Inside a batch the frame waits for the end of the chunk; outside one --
    // a page key, an arrow, a test pressing a single key -- it draws at once.
    if (!inKeyBatch()) { draw(); return; }
    this.scrollPaintQueued = true;
    this.stopScrollBatch ??= onKeyBatchEnd(() => { if (this.scrollPaintQueued) draw(); });
  }



  /** True while the reader is looking at something other than the live end. */
  get scrolledBack(): boolean { return this.alternateScrollback > 0; }

  /** Keys that move the transcript rather than the draft, in the one place
   * both the prompt and the waiting band read them from. Reading back is
   * wanted most while a turn runs -- which is the half that had no scrolling
   * at all, so a page key or a wheel notch reached the draft editor instead.
   * Returns whether the key was spent here. */
  private handleScrollKey(key: string): boolean {
    if (!this.alternateScreen) return false;
    if (isMouseEvent(key)) {
      // Every mouse report is consumed, wheel or not: a click belongs to the
      // client's own selection, never to the composer.
      const rows = wheelScrollRows(key);
      // Queued and drained -- a flick is hundreds of notches in one read.
      if (rows) this.queueScroll(rows);
      return true;
    }
    const page = Math.max(1, this.viewportRows() - 3);
    if (key === '\u001b[5~') { this.scrollTranscript(page); return true; }
    if (key === '\u001b[6~') { this.scrollTranscript(-page); return true; }
    // Ctrl+B and Ctrl+F, a page at a time, as less and vi have always read.
    //
    // A phone keyboard has no page keys, but its key bar has ctrl, so these
    // two are reachable by hand where PageUp and PageDown are not.
    if (key === '\u0002') { this.scrollTranscript(page); return true; }
    if (key === '\u0006') { if (!this.scrollTranscript(-page)) this.noteReadingDirection(); return true; }
    return false;
  }

  /** Down at the live end moves nothing, and says so.
   *
   * There is nothing newer than the newest, so the key is a correct no-op --
   * and an invisible one, which is worse than useless when the only way to
   * read back on a client is its arrow keys: the request looks like a broken
   * feature rather than a wrong direction. Inverting it instead was tried and
   * is worse, because then nothing settles at the live end: every press
   * bounces back into the history. So it stays a no-op, and it tells the
   * reader which way to go. */
  private noteReadingDirection(): boolean {
    if (this.scrolledBack || this.alternateTranscript.length === 0) return false;
    this.showTransientNotice(
      '↑ or Ctrl+B to read earlier messages',
      2000,
      () => this.paint(this.draft, this.draftOptions, this.draftSelected, this.draftPrompt, this.draftCursor, this.draftPalette),
    );
    this.paint(this.draft, this.draftOptions, this.draftSelected, this.draftPrompt, this.draftCursor, this.draftPalette);
    return true;
  }

  /** Forget where on screen the live block sits: whoever writes next (the
   * shell, a vendor CLI, a resize) decides that now. */
  private forgetScreenPosition(): void {
    this.alternatePrevious = [];
  }

  private showTransientNotice(text: string, durationMs: number, redraw: () => void): void {
    this.clearTransientNotice();
    this.transientNotice = text;
    this.transientNoticeTimer = setTimeout(() => {
      this.transientNoticeTimer = undefined;
      this.transientNotice = undefined;
      if (!this.closed && !this.suspended) redraw();
    }, durationMs);
    this.transientNoticeTimer.unref();
  }

  private clearTransientNotice(): void {
    if (this.transientNoticeTimer) clearTimeout(this.transientNoticeTimer);
    this.transientNoticeTimer = undefined;
    this.transientNotice = undefined;
  }

  /** Ctrl+Z. Raw mode swallows the terminal's own job control, so do what it
   * would have done: give the terminal back exactly as close() would, stop
   * this process, and rebuild the live region below whatever the shell printed
   * once `fg` continues it. */
  private suspendToShell(): void {
    if (this.suspended || this.closed) return;
    this.suspended = true;
    if (this.responsePaintTimer) clearTimeout(this.responsePaintTimer);
    this.responsePaintTimer = undefined;
    this.pendingLive = undefined;
    setTerminalRawMode(false);
    output.write(
      `${popReadModes()}`
      // Whoever takes the terminal takes the main screen with it: a vendor
      // login prompt drawn on our alternate screen would vanish with it.
      + terminalTeardown(this.alternateScreen),
    );
    if (this.alternateScreen) terminalModes.alternateScreen = false;
    process.once('SIGCONT', this.onContinue);
    process.kill(process.pid, 'SIGTSTP');
  }

  private readonly onContinue = (): void => {
    if (this.closed) return;
    this.suspended = false;
    if (this.alternateScreen && !terminalModes.alternateScreen) {
      output.write(ENTER_ALTERNATE_SCREEN);
      terminalModes.alternateScreen = true;
    }
    this.lastColumns = output.columns || 0;
    // The shell printed its own rows while it had the terminal, so the row
    // this block used to start on means nothing now.
    this.forgetScreenPosition();
    this.resumeInput?.();
    if (this.waitingLabel) this.paint(this.waitingDraft, [], 0, '› ', this.waitingCursor);
    else this.paint(this.draft, this.draftOptions, this.draftSelected, this.draftPrompt, this.draftCursor, this.draftPalette);
  };


  /** Remove a completed palette/picker as one frame. Painting an empty
   * composer here left its borders/status rows alive while the selected slash
   * command ran, which looked like a composer floating above blank space. */
  private clearInteractiveFrame(): void {
    this.renderFrame([], [], 0, 1, true);
  }

  async question(
    prompt: string,
    commands: readonly PaletteEntry[] = [],
    settings?: { cancellable?: boolean; rightArrowPalette?: boolean },
  ): Promise<string> {
    if (!input.isTTY) {
      // A single check here used to end the whole session the instant it
      // failed once -- fatal specifically after a long suspend/resume
      // window (a vendor login's own OAuth wait, the one case this
      // codebase has anything that runs for 20+ seconds with the real
      // terminal handed over), where a connection hiccup reconnecting a
      // moment later still read as isTTY=false on the very next check and
      // silently discarded whatever the suspended command was about to
      // save, with no error and no crash log to show for it (this exact
      // path, confirmed live: real OAuth completed, then the whole process
      // was just gone). Retrying briefly gives a transient blip a real
      // chance to resolve before treating the terminal as genuinely closed.
      for (let attempt = 0; attempt < 20 && !input.isTTY; attempt++) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      }
      if (!input.isTTY) throw Object.assign(new Error('terminal input is closed'), { code: 'ERR_USE_AFTER_CLOSE' });
    }
    return new Promise((resolveQuestion, rejectQuestion) => {
      let value = this.queuedDraft ?? '';
      this.queuedDraft = undefined;
      let cursor = value.length;
      let selected = 0;
      let historyIndex = this.history.length;
      // Reserved once for the whole prompt, not recomputed per keystroke: keeping the
      // footer band a fixed height is what stops the conversation area above it from
      // reflowing (and the cursor from jumping) as the number of matches narrows.
      const paletteCapacity = commands.length ? Math.min(commands.length, 8) + 2 : 0;
      // No .slice(0, 8) here: that used to cap the real match list itself,
      // not just what's visible at once, so typing "/" (matching every
      // command) could never scroll to anything past the 8th regardless of
      // how far down you pressed -- selected's own wraparound never saw
      // past index 7 because options.length itself was capped there. The
      // windowed scroll in paint() below already exists specifically to
      // show a scrollable slice of a longer list; capping the list before
      // it ever got there defeated that.
      const matches = () => commandPaletteMatches(value, commands);
      let stopInput: () => void = () => {};
      const draw = (): void => {
        const options = commandPaletteMatches(value, commands);
        if (selected >= options.length) selected = 0;
        if (options.length) {
          // After a space the palette is that one command's argument hint.
          const hint = value.includes(' ') ? 'Enter run · Esc clear' : undefined;
          this.paint(value, options, selected, prompt, cursor, { capacity: paletteCapacity, ...(hint ? { hint } : {}) });
          this.paletteActive = true;
          return;
        }
        this.paletteActive = false;
        // Palette closure and ordinary typing are both complete frames, so
        // the transcript immediately reclaims any previously reserved rows.
        this.paint(value, [], 0, prompt, cursor);
      };
      const finish = (answer: string): void => {
        if (finished) return;
        finished = true;
        this.paletteActive = false;
        stopInput();
        output.write(`${popReadModes()}\u001b[?25h`);
        this.resumeInput = undefined;
        this.clearTransientNotice();
        if (answer) this.panelState = undefined;
        if (answer && !answer.startsWith('/') && this.history[this.history.length - 1] !== answer) this.history.push(answer);
        resolveQuestion(answer);
      };
      let finished = false;
      // Opt-in, not a default: this same question() drives the persistent
      // chat composer too, where Esc doing nothing is the existing,
      // intentional behavior (there's nothing to "cancel" mid-draft the way
      // there is for a one-off prompt). Callers that need real cancel
      // semantics -- like the API-key env-var-name prompt, previously
      // "esc doesn't cancel" with no way out short of Ctrl+C -- pass
      // { cancellable: true } and get a real rejection to catch, instead of
      // an empty string indistinguishable from "accepted the default".
      const cancel = (): void => {
        if (finished) return;
        finished = true;
        this.paletteActive = false;
        stopInput();
        output.write(`${popReadModes()}\u001b[?25h`);
        rejectQuestion(Object.assign(new Error('cancelled'), { code: 'ERR_PROMPT_CANCELLED' }));
      };
      const handleKey = (key: string): void => {
        const matched = matches();
        // `options` drives selection keys. While an argument is being typed the
        // palette is only a hint, and every key edits the draft as usual.
        const options = value.includes(' ') ? [] : matched;
        const pasted = pastedText(key);
        if (pasted !== undefined) {
          // Pasted newlines are content, not Enter. Splitting on them is what
          // turned one pasted block into a queue of separate messages.
          value = value.slice(0, cursor) + pasted + value.slice(cursor);
          cursor += pasted.length;
          selected = 0;
          return draw();
        }
        if (key === '\u001a') return this.suspendToShell();
        if (!value && !matched.length && this.panelKey(key)) return draw();
        if (key === '\u0003') {
          // Ctrl+C clears a draft first. Leaving takes a second press, because
          // the same key also interrupts a turn and is pressed by reflex.
          if (value) { value = ''; cursor = 0; selected = 0; historyIndex = this.history.length; return draw(); }
          if (Date.now() - exitArmedAt <= EXIT_CONFIRM_MS) return finish('/exit');
          exitArmedAt = Date.now();
          this.showTransientNotice('Press Ctrl+C again to exit', EXIT_CONFIRM_MS, draw);
          return draw();
        }
        if (exitArmedAt) { exitArmedAt = 0; this.clearTransientNotice(); }
        // Ctrl+D is end-of-input only on an empty draft; otherwise it deletes
        // forward like every other line editor.
        if (key === '\u0004' && !value) return finish('/exit');
        if (key === '\u001b' && settings?.cancellable) return cancel();
        if (key === '\u001b' && matched.length) {
          value = '';
          cursor = 0;
          selected = 0;
          return draw();
        }
        if (key === '\r') {
          const continued = options.length ? undefined : backslashNewline(value, cursor);
          if (continued) { value = continued.value; cursor = continued.cursor; return draw(); }
          if (options.length && value.startsWith('/') && !value.includes(' ')) {
            // What was typed wins when it names a command outright: `/new`
            // must run /new even while a better-ranked row is highlighted.
            const command = exactPaletteCommand(value, commands) ?? options[selected].value;
            // Deliberately NOT cleared here. Blanking the region on submit
            // leaves the screen empty for however long the command takes to
            // produce its first frame, which read as "the composer vanished".
            // The palette rows stay up for the moment in between and are
            // replaced by whatever the command paints next.
            return finish(command);
          }
          return finish(value);
        }
        if (key === '\t' && options.length) {
          // A command that takes an argument completes ready for it.
          value = `${options[selected].value}${options[selected].argHint ? ' ' : ''}`;
          cursor = value.length;
          selected = 0;
          return draw();
        }
        // Up/Down navigate palette options; otherwise they move through a
        // multi-line draft and fall through to input history from its first
        // and last line. (Wheel/touch scrolling belongs to the terminal and
        // never arrives as these keys.) Ctrl+P/Ctrl+N always mean history.
        const historyStep = (direction: -1 | 1): void => {
          if (direction < 0 && historyIndex > 0) historyIndex -= 1;
          else if (direction > 0) historyIndex = Math.min(this.history.length, historyIndex + 1);
          else return;
          value = this.history[historyIndex] ?? '';
          cursor = value.length;
        };
        if (key === '\u001b[A' || key === '\u001b[B') {
          const direction = key === '\u001b[A' ? -1 : 1;
          if (options.length) { selected = (selected + direction + options.length) % options.length; return draw(); }
          // An empty composer means the conversation is what is being looked
          // at, so the arrows read it. Recorded from a real phone client: a
          // swipe arrives as arrow keys and nothing else -- no mouse report in
          // any encoding, and no page keys on the keyboard -- so on that
          // client this is the only way back through the conversation at all.
          // History keeps Ctrl+P and Ctrl+N, which is where it always was as
          // well, and the arrows still move through a draft once there is one.
          if (!value && this.alternateScreen) {
            if (this.scrollTranscript(direction === -1 ? SWIPE_ROWS : -SWIPE_ROWS)) return;
            if (direction === 1 && this.noteReadingDirection()) return;
          }
          const moved = composerVerticalMove(value, cursor, direction);
          if (moved !== undefined) cursor = moved;
          else historyStep(direction);
          return draw();
        }
        if (key === '\u0010' && !options.length) { historyStep(-1); return draw(); }
        if (key === '\u000e' && !options.length) { historyStep(1); return draw(); }
        if (key === '\u001b[D') {
          if (options.length) { value = ''; cursor = 0; selected = 0; }
          else cursor = previousCharacterIndex(value, cursor);
          return draw();
        }
        if (key === '\u001b[C') {
          if (options.length && value.startsWith('/') && !value.includes(' ')) {
            // Right Arrow is deliberately identical to Enter, including the
            // decision above not to blank the region while the command runs.
            const command = options[selected].value;
            return finish(command);
          }
          const paletteValue = composerRightArrowValue(value, options.length > 0, settings?.rightArrowPalette);
          if (paletteValue) {
            value = paletteValue;
            cursor = value.length;
            selected = 0;
            return draw();
          }
          cursor = nextCharacterIndex(value, cursor);
          return draw();
        }
        // Page keys read the conversation rather than edit the draft: the
        // alternate screen has no terminal scrollback behind it, so this is
        // the only way back through what was said. Shift+Up/Down does the
        // same a row at a time. Esc, which already clears a draft, also
        // returns to the live end.
        if (this.handleScrollKey(key)) return;
        // Escape returns to the live end here; in the waiting band it keeps
        // meaning interrupt, and a new turn rejoins on its own.
        if (key === '\u001b' && this.scrolledBack) { this.scrollTranscript(-Number.MAX_SAFE_INTEGER); return; }
        // Everything else is text editing, shared with the waiting composer.
        const edited = editComposer(value, cursor, key);
        if (!edited.changed) return;
        if (edited.value !== value) selected = 0;
        value = edited.value;
        cursor = edited.cursor;
        draw();
      };
      let exitArmedAt = 0;
      const listen = (): void => {
        setTerminalRawMode(true);
        input.resume();
        output.write(enterInputModes());
        stopInput = listenForTerminalKeys((key) => { if (!finished) handleKey(key); });
      };
      this.resumeInput = () => { stopInput(); if (!finished) listen(); };
      listen();
      draw();
    });
  }

  /** Provider/model/effort pickers share the same atomic frame and palette
   * layout as slash commands, so the conversation stays visible above them. */
  /** Type-to-filter: a picker with more than a screenful of options (the
   * /resume list, across every ClikCode session plus every discovered vendor
   * chat, easily exceeds 50) was arrow-keys-only with no count, no scroll
   * indicator, and silent wraparound at each end -- a real conversation could
   * sit in the middle of a list that long and be effectively unfindable by
   * scrolling alone. Letters/digits/space now narrow the list live by
   * substring match against label and detail (title, provider, status);
   * arrow keys still navigate whatever is currently visible. This is why the
   * old 'j'/'k'/'q' single-letter aliases are gone: they would collide with
   * typing a real filter query character (searching for "qwen" or "junk"). */
  select<T>(
    title: string,
    options: readonly PickerOption<T>[],
    onAction?: (value: T, action: string) => Promise<void>,
    settings?: {
      onBack?: () => void;
      onEscape?: () => void;
      refreshedOptions?: () => readonly PickerOption<T>[];
      refresh?: Promise<unknown>;
    },
  ): Promise<T | undefined> {
    if (!options.length) return Promise.resolve(undefined);
    return new Promise((resolveSelection) => {
      this.selecting = true;
      let query = '';
      let selected = 0;
      let stopInput: () => void = () => {};
      const capacity = Math.min(options.length, 8) + 2;
      const currentOptions = (): readonly PickerOption<T>[] => settings?.refreshedOptions?.() ?? options;
      const visibleOptions = (): readonly PickerOption<T>[] => {
        const current = currentOptions();
        if (!query) return current;
        const needle = query.toLowerCase();
        return current.filter((option) =>
          option.label.toLowerCase().includes(needle)
          || (option.detail ?? '').toLowerCase().includes(needle));
      };
      const draw = (): void => {
        const visible = visibleOptions();
        if (selected >= visible.length) selected = Math.max(0, visible.length - 1);
        const renderOptions = visible.map((option) => ({ label: option.label, detail: option.detail, value: '' }));
        const confirmation = '\u2192/Enter';
        const selectedOption = visible[selected];
        const secondary = selectedOption?.alternates?.length ? ' · Tab history'
          : selectedOption?.actions?.length ? ' · Tab options' : '';
        const destructive = selectedOption?.deleteAction ? ` · Del ${selectedOption.deleteAction.label.toLowerCase()}` : '';
        const hint = query
          ? `"${query}" - ${visible.length} match${visible.length === 1 ? '' : 'es'} · \u2191\u2193 move · ${confirmation} choose${secondary}${destructive} · \u2190 back · Esc exit`
          : `${currentOptions().length} total · \u2191\u2193 move · ${confirmation} choose${secondary}${destructive} · \u2190 back · Esc exit · type to filter`;
        this.paint(title, renderOptions, selected, '', 0, { capacity, hideCursor: true, hint });
      };
      let finished = false;
      const finish = (value: T | undefined): void => {
        if (finished) return;
        finished = true;
        this.selecting = false;
        stopInput();
        this.clearInteractiveFrame();
        resolveSelection(value);
      };
      // Tab opens optional non-destructive management actions. Right Arrow is
      // deliberately identical to Enter for every picker.
      const openActions = async (option: PickerOption<T>): Promise<void> => {
        if (!option.actions?.length) return;
        stopInput();
        let escaped = false;
        const actionValue = await this.select(
          option.label,
          option.actions.map((action) => ({ label: action.label, value: action.value })),
          undefined,
          { onEscape: () => { escaped = true; } },
        );
        if (escaped) {
          settings?.onEscape?.();
          finish(undefined);
          return;
        }
        if (actionValue) {
          await onAction?.(option.value, actionValue);
          // Let the caller rebuild the parent options from authoritative
          // state (for example, Disconnect changes an account's status).
          // Repainting the captured array here would show stale details.
          finish(undefined);
          return;
        }
        if (finished) return;
        setTerminalRawMode(true);
        input.resume();
        stopInput = listenForTerminalKeys((key) => { if (!finished) handleKey(key); });
        draw();
      };
      const openAlternates = async (option: PickerOption<T>): Promise<void> => {
        if (!option.alternates?.length) return;
        stopInput();
        const value = await this.select(option.label, option.alternates);
        if (value !== undefined) return finish(value);
        if (finished) return;
        setTerminalRawMode(true);
        input.resume();
        stopInput = listenForTerminalKeys((key) => { if (!finished) handleKey(key); });
        draw();
      };
      const confirmDelete = async (option: PickerOption<T>): Promise<void> => {
        const action = option.deleteAction;
        if (!action) return;
        stopInput();
        const confirmed = await this.select(`${action.label} ${option.label}?`, [
          { label: 'Cancel', value: false },
          { label: `${action.label} ${option.label}`, value: true },
        ]);
        if (confirmed) {
          await onAction?.(option.value, action.value);
          finish(undefined);
          return;
        }
        if (finished) return;
        setTerminalRawMode(true);
        input.resume();
        stopInput = listenForTerminalKeys((key) => { if (!finished) handleKey(key); });
        draw();
      };
      const handleKey = (key: string): void => {
        const visible = visibleOptions();
        if (key === '\u001b[A') selected = visible.length ? (selected - 1 + visible.length) % visible.length : 0;
        else if (key === '\u001b[B') selected = visible.length ? (selected + 1) % visible.length : 0;
        else if (key === '\u001b[D') { settings?.onBack?.(); finish(undefined); return; }
        else if (pickerConfirmsSelection(key)) { if (visible[selected]) finish(visible[selected].value); return; }
        else if (key === '\t') {
          const option = visible[selected];
          if (option?.alternates?.length) void openAlternates(option);
          else if (option?.actions?.length) void openActions(option);
          return;
        }
        else if (pickerDeletesSelection(key)) { if (visible[selected]?.deleteAction) void confirmDelete(visible[selected]); return; }
        else if (key === '\u0003') return finish(undefined);
        else if (key === '\u001b') { settings?.onEscape?.(); return finish(undefined); }
        else if (key === '\u007f' || key === '\b') { if (!query) return; query = query.slice(0, -1); selected = 0; }
        else if (key.length === 1 && key >= ' ') { query += key; selected = 0; }
        else return;
        draw();
      };
      setTerminalRawMode(true);
      input.resume();
      stopInput = listenForTerminalKeys((key) => { if (!finished) handleKey(key); });
      draw();
      void settings?.refresh?.then(() => { if (!finished) draw(); }, () => { if (!finished) draw(); });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pendingLive = undefined;
    if (this.responsePaintTimer) clearTimeout(this.responsePaintTimer);
    this.responsePaintTimer = undefined;
    this.stopWaiting(false);
    this.clearTransientNotice();
    if (this.resizePaintTimer) clearTimeout(this.resizePaintTimer);
    this.resizePaintTimer = undefined;
    this.stopScrollBatch?.();
    this.stopScrollBatch = undefined;
    this.stopDrainBatch?.();
    this.stopDrainBatch = undefined;
    if (this.scrollDrainTimer) clearTimeout(this.scrollDrainTimer);
    this.scrollDrainTimer = undefined;
    this.pendingScroll = 0;

    input.off('data', KEEP_STDIN_FLOWING);
    process.off('SIGWINCH', this.onResize);
    process.off('SIGCONT', this.onContinue);
    process.off('exit', restoreTerminal);
    setTerminalRawMode(false);
    input.pause();
    // On the main screen the conversation stays in the terminal's scrollback
    // where it can still be read and copied, and only this UI's own live
    // region goes; on the alternate screen the whole thing is handed back and
    // the shell's own screen returns untouched. The conversation is on disk
    // either way -- `/resume` reopens it.
    output.write(
      `${popReadModes()}`
      + terminalTeardown(terminalModes.alternateScreen),
    );
    terminalModes.alternateScreen = false;
    terminalModes.painted = false;
    terminalModes.leaveLiveRegion = undefined;
  }

  /** Hands the real terminal to a vendor CLI's own interactive flow (typically
   * login) without tearing the session down, so ClikCode's UI can resume in
   * place once that process exits. */
  async suspend(): Promise<void> {
    this.suspended = true;
    this.pendingLive = undefined;
    this.forgetScreenPosition();
    if (this.responsePaintTimer) clearTimeout(this.responsePaintTimer);
    this.responsePaintTimer = undefined;
    setTerminalRawMode(false);
    input.pause();
    // Remove the composer and footer before handing over, so the vendor's
    // output continues directly under the conversation instead of being typed
    // across this UI's status rows.
    output.write(`${popReadModes()}${terminalTeardown(false)}`);
    // Best-effort mitigation, not a confirmed root cause: a vendor login's
    // own paste handling erroring right after handoff is plausibly a race
    // between the terminal actually finishing its mode switch (raw -> cooked,
    // bracketed paste off; this UI never uses the alternate screen) and the
    // child process starting to read --
    // both writes above are fire-and-forget from Node's side, with no way to
    // know when the terminal itself has caught up. A short settle window
    // before the caller spawns anything costs nothing on the success path
    // and closes the gap if that race is real.
    await new Promise((resolveSettle) => setTimeout(resolveSettle, 50));
  }

  resume(): void {
    if (this.closed) return;
    // A vendor login can resize a mobile terminal while it owns the TTY.
    // Re-seed the authoritative transcript at the new width when control
    // returns; native scrollback remains available above the refreshed view.
    this.suspended = false;
    if (this.alternateScreen && !terminalModes.alternateScreen) {
      output.write(ENTER_ALTERNATE_SCREEN);
      terminalModes.alternateScreen = true;
    }
    this.forgetScreenPosition();
    // Whatever the vendor printed stays in scrollback and the live region
    // simply starts again below it: leaving the alternate screen left nothing
    // UI's own on screen, so the next frame begins wherever the cursor is.
    this.lastColumns = output.columns || 0;
    if (input.isTTY) input.resume();
    this.paint(this.draft, this.draftOptions, this.draftSelected, this.draftPrompt, this.draftCursor);
  }
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
