/** Bytes to keys. Mobile and remote terminals split one escape sequence, and
 * even one UTF-8 character, across data chunks, so decoding is stateful; this
 * also normalizes modern key encodings back to the legacy bytes the rest of
 * the UI matches on, and owns the cursor/input diagnostic log. */

import { NEWLINE_KEY, PASTE_END, PASTE_START } from './keys.js';
import { stdin as input, stdout as output } from 'node:process';
import { StringDecoder } from 'node:string_decoder';
import { nextCharacterIndex } from './render/width.js';
import { logCursorEvent, traceRawInput } from './cursor-log.js';
import { noteProbeReply } from './probe.js';
import { LEGACY_MOUSE_PREFIX, setTerminalRawMode } from './modes.js';

/** A key's meaning while a turn runs. Esc takes a waiting message back, and
 * with none it is handled by the turn itself: an unanswered prompt returns
 * to the composer, and a turn that has started answering stops. Ctrl+C
 * stops. */
type WaitingInputAction = 'take-back' | 'stop';

const ESCAPE_SEQUENCE_TIMEOUT_MS = 120;

/** How long a lone Esc waits once this link has been seen to split a sequence after its first byte (a rejoin happened): a late
 * `[A` cannot then arrive after the Esc was already taken for a keypress. */
const SLOW_LINK_ESCAPE_TIMEOUT_MS = 500;

/** How long after an Esc was given up on (or an unfinished `ESC [ ...` dropped) the rest of its sequence is still taken as the rest. */
const REJOIN_WINDOW_MS = 1_000;

/** What a split sequence's remainder looks like when it arrives alone: the rest of a CSI (`[A`, `[1;5C`, `[200~` is a paste and
 * not rejoined), or an SS3 cursor key (`OA`..`OD`, `OH`, `OF`). Never `OK`: a word typed after Esc must stay typed. */
const CSI_REMAINDER = /^\[[\d;:?<]*[@-~]?$/;
const SS3_REMAINDER = /^O[ABCDHF]$/;

/** Set once any decoder has rejoined a split sequence: this link splits them, so a lone Esc waits longer from then on. */
let slowLink = false;
/** For tests: the link is not known to be slow. */
export function forgetSlowLink(): void { slowLink = false; }

/** An OSC reply longer than this without a terminator is not one. */
const MAX_OSC_LENGTH = 4096;

/** A bracketed paste is held until its end fence, however slowly the link
 * delivers it: flushing early submitted the first half as a message. This is
 * only the escape hatch for a terminal that never sends the fence, measured
 * from the last chunk, so a paste that is still arriving is never cut. */
const OPEN_PASTE_TIMEOUT_MS = 10_000;

export function waitingInputAction(key: string): WaitingInputAction | undefined {
  if (key === '\u001b') return 'take-back';
  if (key === '\u0003') return 'stop';
  return undefined;
}

/** Enter while a turn runs. Something typed is delivered -- into the turn or
 * after it, by the send mode. Nothing typed, with a message already waiting
 * (its row is on screen, so this is the SECOND Enter, never a doubled first),
 * puts that message into the chat. The turn is not stopped. */
export function waitingEnterAction(draft: string, waiting: boolean, canSend: boolean): 'deliver' | 'send-waiting' | undefined {
  if (draft.trim()) return 'deliver';
  return waiting && canSend ? 'send-waiting' : undefined;
}

/** `CSI I` / `CSI O`: the window gained or lost focus. Never a keystroke. */
const FOCUS_EVENT = /^\u001b\[[IO]$/;

/** `CSI ? ... c`: the terminal answering Primary DA. Never a keystroke. */
const DEVICE_ATTRIBUTES_REPLY = /^\u001b\[\?[0-9;]*c$/;

/** A private-mode report no one here asked for -- `CSI ? Pn $ y` (DECRQM) -- is a terminal talking, never typing. (The phone page's
 * `CSI ? 9701 ; rows t` size report is no longer decoded: the page stopped sending it, ClikDeployMobile b5e31c7.) */
const PRIVATE_REPORT = /^\u001b\[\?\d+(?:;\d+)*\$y$/;

/** Readers attached now (listenForTerminalKeys), and what the terminal sent
 * while there were none: kept for the next one. */
let readers = 0;
let unread: (Buffer | string)[] = [];
let unreadBytes = 0;
const UNREAD_LIMIT = 64 * 1024;

/** Attached for the life of the prompter so stdin never falls back to paused
 * mode between readers. Between readers -- one screen closing and the next
 * opening, a sign-in's wait giving way to the prompt -- it keeps what arrives
 * for the next reader. Dropping it lost the keys typed in that moment: a
 * message typed as a sign-in finished was sent as "heck the commit". */
export const KEEP_STDIN_FLOWING = (chunk?: Buffer | string): void => {
  if (readers > 0 || chunk === undefined || unreadBytes + chunk.length > UNREAD_LIMIT) return;
  unread.push(chunk);
  unreadBytes += chunk.length;
};

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
  /** When a bare Esc was given up on at a flush (its sequence may still be on the wire). */
  private loneEscAt: number | undefined;
  /** An unfinished `ESC [ ...` dropped at a flush, and when. */
  private orphan: { text: string; at: number } | undefined;

  push(chunk: Buffer | string): string[] {
    const text = typeof chunk === 'string' ? chunk : this.utf8.write(chunk);
    this.rejoin(text);
    this.pending += text;
    return this.drain(false);
  }

  /** A sequence whose first bytes were given up on and whose rest arrives within the window is one sequence: the rest is not
   * typed text. An unfinished `ESC [ ...` that was dropped is put back in front of it. A bare Esc already delivered cannot be
   * taken back, but the rest is read as the key it was and not typed as `[A`; and this link now waits longer for the next. */
  private rejoin(text: string): void {
    const now = Date.now();
    const orphan = this.orphan;
    const lone = this.loneEscAt;
    this.orphan = undefined;
    this.loneEscAt = undefined;
    if (this.pending) return;
    if (orphan && now - orphan.at <= REJOIN_WINDOW_MS && !text.startsWith('\u001b')) {
      this.pending = orphan.text;
      slowLink = true;
    } else if (lone !== undefined && now - lone <= REJOIN_WINDOW_MS && (CSI_REMAINDER.test(text) || SS3_REMAINDER.test(text))) {
      this.pending = '\u001b';
      slowLink = true;
    }
  }

  flush(): string[] {
    this.pending += this.utf8.end();
    return this.drain(true);
  }

  /** How long to wait for more bytes before `flush()` gives up on what is
   * pending, or undefined when nothing is. */
  flushDelayMs(): number | undefined {
    if (!this.pending) return undefined;
    return this.pending.startsWith(PASTE_START) ? OPEN_PASTE_TIMEOUT_MS : slowLink ? SLOW_LINK_ESCAPE_TIMEOUT_MS : ESCAPE_SEQUENCE_TIMEOUT_MS;
  }

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
        if (flush) { keys.push('\u001b'); this.pending = ''; this.loneEscAt = Date.now(); }
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
          // Unfinished: its tail is on the wire. Not an Esc followed by typed `[1;5`: kept for the rest to join.
          if (flush) { this.orphan = { text: this.pending, at: Date.now() }; this.pending = ''; continue; }
          break;
        }
        keys.push(normalizeTerminalKey(this.pending.slice(0, end + 1)));
        this.pending = this.pending.slice(end + 1);
        continue;
      }
      if (prefix === 'O') {
        if (this.pending.length < 3) {
          if (flush) { this.orphan = { text: this.pending, at: Date.now() }; this.pending = ''; continue; }
          break;
        }
        keys.push(normalizeTerminalKey(this.pending.slice(0, 3)));
        this.pending = this.pending.slice(3);
        continue;
      }
      // OSC: `ESC ] ... BEL` or `... ESC \\`. A terminal's answer to a colour
      // query arrives this way. Read as Alt+] it left its body ("11;rgb:...")
      // in the draft as typed text. One key, dropped by the listener. While
      // its terminator has not come it waits; at the flush it was Alt+] and
      // whatever followed was typed, so no typed text is ever swallowed.
      if (prefix === ']') {
        const bell = this.pending.indexOf('\u0007', 2);
        const stop = this.pending.indexOf('\u001b\\', 2);
        const close = bell === -1 ? stop : stop === -1 ? bell : Math.min(bell, stop);
        if (close === -1) {
          if (!flush && this.pending.length < MAX_OSC_LENGTH) break;
          keys.push(this.pending.slice(0, 2));
          this.pending = this.pending.slice(2);
          continue;
        }
        const length = close + (this.pending[close] === '\u0007' ? 1 : 2);
        keys.push(this.pending.slice(0, length));
        this.pending = this.pending.slice(length);
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
const CURSOR_POSITION_REPORT = /^\u001b\[(\d+);\d+R$/;

/** Who is waiting for the terminal to say where its cursor is. */
const cursorReports = new Set<(row: number) => void>();

/** Asks the terminal for its cursor's row (`CSI 6 n`, which moves nothing) and hands it to `done`, counted from zero; or
 * `undefined` when nothing answers in time. */
export function askCursorRow(done: (row: number | undefined) => void, timeoutMs = 300): void {
  const finish = (row: number | undefined): void => {
    if (!cursorReports.delete(listener)) return;
    clearTimeout(timer);
    done(row);
  };
  const listener = (row: number): void => finish(row);
  const timer = setTimeout(() => finish(undefined), timeoutMs);
  cursorReports.add(listener);
  output.write('\u001b[6n');
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

/** Focus reports (`CSI I` / `CSI O`) never reach a key handler; whoever
 * cares whether the terminal is being looked at listens here. */
const focusListeners = new Set<(focused: boolean) => void>();

export function onTerminalFocus(listener: (focused: boolean) => void): () => void {
  focusListeners.add(listener);
  return () => { focusListeners.delete(listener); };
}

/** The keyboard has one owner: the reader attached last (a picker, the board,
 * a palette over a running turn). Keys go to it alone, so an overlay consumes
 * Esc and the turn's own handler under it never sees it. This is the single
 * routing rule; no handler checks whether something else is open. */
const keyOwners: object[] = [];

function listenForTerminalKeys(onKey: (key: string) => void): () => void {
  const owner = {};
  keyOwners.push(owner);
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
      // Escape sequences and control keys -- never typed text, which is the
      // user's message. "Scrolling does nothing" or "the key does nothing"
      // has causes that look identical from here (nothing sent, an encoding
      // we do not decode, a key decoded and dropped); the log tells them apart.
      // Backspace too: it is what a Mac or iPhone "delete" key sends.
      if (key.startsWith('\u001b') || key.charCodeAt(0) < 0x20 || key === '\u007f') {
        logCursorEvent(`input ${JSON.stringify(key)} screen=${output.columns ?? '?'}x${output.rows ?? '?'}`);
      }
      // A DSR reply is the terminal talking back, not the user typing: whoever
      // asked (askCursorRow) gets it, and one nobody asked for is dropped.
      const report = CURSOR_POSITION_REPORT.exec(key);
      if (report) {
        for (const listener of [...cursorReports]) listener(Number(report[1]) - 1);
        continue;
      }
      // Focus in/out and OSC replies (theme notifications), likewise:
      // enabled for what they announce, not to be read.
      if (FOCUS_EVENT.test(key)) {
        for (const listener of [...focusListeners]) listener(key === '\u001b[I');
        continue;
      }
      if (key.startsWith('\u001b]')) continue;
      if (noteProbeReply(key) || PRIVATE_REPORT.test(key)) continue;
      // Answers to the questions the opening handshake asks: Primary DA comes
      // back as `CSI ? ... c`, XTVERSION as a DCS string. Neither is a key,
      // and a terminal that answers must not be able to type into the draft.
      if (DEVICE_ATTRIBUTES_REPLY.test(key) || key.startsWith('\u001bP')) continue;
      onKey(key);
    }
  };
  const onData = (chunk: Buffer | string): void => {
    if (keyOwners.at(-1) !== owner) { if (flushTimer) clearTimeout(flushTimer); flushTimer = undefined; decoder.flush(); return; }
    traceRawInput(chunk);
    if (flushTimer) clearTimeout(flushTimer);
    deliver(decoder.push(chunk));
    const delay = decoder.flushDelayMs();
    if (delay !== undefined) {
      // A lone Escape must eventually be delivered, but mobile SSH links can
      // split a cursor/mouse sequence across packets by more than one frame.
      flushTimer = setTimeout(() => deliver(decoder.flush()), delay);
      flushTimer.unref();
    }
  };
  input.on('data', onData);
  readers += 1;
  let attached = true;
  // What came while nobody was reading goes to this reader first -- on the
  // next tick, once whoever attached it has finished setting up. Anything
  // the terminal sends meanwhile is an I/O event, so it cannot come first.
  // A reader gone by then leaves them for the one after.
  if (unread.length) {
    process.nextTick(() => {
      if (!attached || !unread.length) return;
      const pending = unread;
      unread = [];
      unreadBytes = 0;
      for (const chunk of pending) onData(chunk);
    });
  }
  return () => {
    if (!attached) return;
    attached = false;
    const at = keyOwners.indexOf(owner);
    if (at >= 0) keyOwners.splice(at, 1);
    readers -= 1;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = undefined;
    input.off('data', onData);
  };
}

/** Take the keyboard: raw mode, stdin flowing, and every key to `onKey`
 * until the returned function is called. What a picker does on opening and
 * again each time a screen it opened hands the keyboard back. */
export function takeTerminalKeys(onKey: (key: string) => void): () => void {
  setTerminalRawMode(true);
  input.resume();
  return listenForTerminalKeys(onKey);
}
