/** Bytes to keys. Mobile and remote terminals split one escape sequence, and
 * even one UTF-8 character, across data chunks, so decoding is stateful; this
 * also normalizes modern key encodings back to the legacy bytes the rest of
 * the UI matches on, and owns the cursor/input diagnostic log. */

import { NEWLINE_KEY, PASTE_END, PASTE_START } from './keys.js';
import { stdin as input, stdout as output } from 'node:process';
import { StringDecoder } from 'node:string_decoder';
import { nextCharacterIndex } from './render/width.js';
import { logCursorEvent } from './cursor-log.js';
import { LEGACY_MOUSE_PREFIX } from './modes.js';

type WaitingInputAction = 'cancel-edit' | 'cancel-stop';

const ESCAPE_SEQUENCE_TIMEOUT_MS = 120;

export function waitingInputAction(key: string): WaitingInputAction | undefined {
  if (key === '\u001b') return 'cancel-edit';
  if (key === '\u0003') return 'cancel-stop';
  return undefined;
}

/** `CSI I` / `CSI O`: the window gained or lost focus. Never a keystroke. */
const FOCUS_EVENT = /^\u001b\[[IO]$/;

/** `CSI ? ... c`: the terminal answering Primary DA. Never a keystroke. */
const DEVICE_ATTRIBUTES_REPLY = /^\u001b\[\?[0-9;]*c$/;

/** Attached for the life of the prompter so stdin never falls back to paused
 * mode between readers. It reads nothing; presence is the whole point. */
export const KEEP_STDIN_FLOWING = (): void => {};

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

export function listenForTerminalKeys(onKey: (key: string) => void): () => void {
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

