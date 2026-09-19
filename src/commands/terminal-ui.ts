/** Shared terminal renderer for every harness and the Gateway path. Persisted
 * conversation lines are emitted once into native scrollback; one atomic live
 * region contains only the changing response, controls, and composer. */

import chalk from 'chalk';
import { stdin as input, stdout as output } from 'node:process';
import { StringDecoder } from 'node:string_decoder';
import {
  composerLayout, createStreamingBlockParser, LruCache, nextCharacterIndex, previousCharacterIndex,
  renderInlineMarkdown, renderInlineMarkdownLive, renderTableBlock,
  sanitizeTerminalText, splitIntoBlocks, terminalCellWidth, visibleSlice, wrapCodeLine, wrapWords,
} from './markdown-render.js';
import { restoreTerminal, terminalModes } from './terminal-restore.js';
import { compactPath, harnessSupportsEffort, localHarnessForCommand, renderActivityLine, sessionProviderLabel } from './native-harness-protocol.js';
import { sessionTranscriptMessages } from './turn-checkpoint.js';
import { nativeModelLabel } from './native-account-data.js';
import type { LiveTurnInputResult } from './live-turn-input.js';
import type { HarnessActivityEvent, HarnessPrompter, HarnessSession, MessageBlock, PickerOption } from './types.js';

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
export const BEGIN_SYNCHRONIZED_UPDATE = '\u001b[?2026h';
export const END_SYNCHRONIZED_UPDATE = '\u001b[?2026l';
const EXIT_CONFIRM_MS = 2000;

/** Sequences for entering an interactive read. The kitty flag is pushed at most
 * once however many reads start, so one pop always restores the user's own. */
function enterInputModes(): string {
  let sequence = ENABLE_BRACKETED_PASTE;
  terminalModes.bracketedPaste = true;
  terminalModes.rawMode = true;
  if (!terminalModes.kittyKeyboard && kittyKeyboardSafe()) {
    sequence += PUSH_KITTY_KEYBOARD;
    terminalModes.kittyKeyboard = true;
  }
  return sequence;
}

function leaveInputModes(): string {
  const sequence = `${terminalModes.kittyKeyboard ? POP_KITTY_KEYBOARD : ''}${DISABLE_BRACKETED_PASTE}`;
  terminalModes.kittyKeyboard = false;
  terminalModes.bracketedPaste = false;
  return sequence;
}

const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';

/** The text of a pasted key as it should enter a draft, or undefined for an
 * ordinary keystroke. Terminals deliver a pasted line break as a bare `\r`
 * (and Windows sources as `\r\n`), which drew as one row that kept rewinding
 * over itself instead of a multi-line draft; tabs and any escape sequences
 * smuggled inside the paste are neutralised by the same sanitizer. */
export function pastedText(key: string): string | undefined {
  return key.startsWith(PASTE_START) && key.endsWith(PASTE_END)
    ? sanitizeTerminalText(key.slice(PASTE_START.length, key.length - PASTE_END.length))
    : undefined;
}

/** Kitty keyboard protocol, "disambiguate escape codes" flag only. It is what
 * makes Shift+Enter distinguishable from Enter. It also re-encodes Esc and
 * every Ctrl/Alt chord as `CSI code ; modifiers u`, which normalizeTerminalKey
 * folds back into the legacy bytes the rest of this file matches on. */
export const PUSH_KITTY_KEYBOARD = '\u001b[>1u';
export const POP_KITTY_KEYBOARD = '\u001b[<u';
/** One internal spelling for "insert a newline" however the terminal said it:
 * Alt+Enter, Shift+Enter via CSI u, or xterm's modifyOtherKeys form. */
export const NEWLINE_KEY = '\u001b\r';

/** Pushing the flag is only safe where it is understood: an unaware terminal
 * may echo the sequence, and inside tmux the pop never reaches the outer
 * terminal, leaving the user's shell receiving CSI-u for Ctrl+C. */
export function kittyKeyboardSafe(environment: NodeJS.ProcessEnv = process.env): boolean {
  if (environmentFlag(environment.CLIKCODE_NO_KITTY_KEYBOARD)) return false;
  if (environment.TMUX || environment.STY || /^(?:screen|tmux)/.test(environment.TERM ?? '')) return false;
  const program = (environment.TERM_PROGRAM ?? '').toLowerCase();
  return Boolean(environment.KITTY_WINDOW_ID || environment.GHOSTTY_RESOURCES_DIR || environment.WEZTERM_PANE
    || /^(?:xterm-kitty|xterm-ghostty|foot|alacritty|wezterm)/.test(environment.TERM ?? '')
    || program === 'wezterm' || program === 'ghostty' || program === 'kitty');
}

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
      if (prefix === '[') {
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

function listenForTerminalKeys(onKey: (key: string) => void): () => void {
  const decoder = new TerminalInputDecoder();
  let flushTimer: NodeJS.Timeout | undefined;
  const deliver = (keys: readonly string[]): void => { for (const key of keys) onKey(key); };
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

function previousWordIndex(value: string, cursor: number): number {
  let index = cursor;
  while (index > 0 && /\s/.test(value[index - 1]!)) index -= 1;
  while (index > 0 && !/\s/.test(value[index - 1]!)) index -= 1;
  return index;
}

function nextWordIndex(value: string, cursor: number): number {
  let index = cursor;
  while (index < value.length && /\s/.test(value[index]!)) index += 1;
  while (index < value.length && !/\s/.test(value[index]!)) index += 1;
  return index;
}

const lineStartIndex = (value: string, cursor: number): number => value.lastIndexOf('\n', cursor - 1) + 1;
const lineEndIndex = (value: string, cursor: number): number => {
  const end = value.indexOf('\n', cursor);
  return end === -1 ? value.length : end;
};

/** Move one logical line up or down keeping the display column. Undefined at
 * the first/last line, which is the caller's cue to fall through to history. */
export function composerVerticalMove(value: string, cursor: number, direction: -1 | 1): number | undefined {
  const start = lineStartIndex(value, cursor);
  const column = terminalCellWidth(value.slice(start, cursor));
  let targetStart: number;
  if (direction < 0) {
    if (start === 0) return undefined;
    targetStart = lineStartIndex(value, start - 1);
  } else {
    const end = lineEndIndex(value, cursor);
    if (end >= value.length) return undefined;
    targetStart = end + 1;
  }
  const targetEnd = lineEndIndex(value, targetStart);
  let index = targetStart;
  while (index < targetEnd) {
    const next = nextCharacterIndex(value, index);
    if (terminalCellWidth(value.slice(targetStart, next)) > column) break;
    index = next;
  }
  return index;
}

/** A trailing backslash turns Enter into a line break, the one newline
 * spelling that works in every terminal and over every SSH client. */
export function backslashNewline(value: string, cursor: number): { value: string; cursor: number } | undefined {
  if (cursor <= 0 || value[cursor - 1] !== '\\') return undefined;
  return { value: `${value.slice(0, cursor - 1)}\n${value.slice(cursor)}`, cursor };
}

/** Every text-editing key, shared by the prompt composer and the composer that
 * stays live during a turn. `changed: false` means the key is not an edit and
 * the caller may give it another meaning (history, submit, exit). */
export function editWaitingComposer(value: string, cursor: number, key: string): { value: string; cursor: number; changed: boolean } {
  const pasted = pastedText(key);
  const insert = (text: string) => ({ value: value.slice(0, cursor) + text + value.slice(cursor), cursor: cursor + text.length, changed: true });
  const remove = (from: number, to: number) => ({ value: value.slice(0, from) + value.slice(to), cursor: from, changed: true });
  if (pasted !== undefined) return insert(pasted);
  if (key === NEWLINE_KEY || key === '\n') return insert('\n');
  if (key === '\u001b[D') return { value, cursor: previousCharacterIndex(value, cursor), changed: true };
  if (key === '\u001b[C') return { value, cursor: nextCharacterIndex(value, cursor), changed: true };
  if (key === '\u001b[A' || key === '\u001b[B') {
    const moved = composerVerticalMove(value, cursor, key === '\u001b[A' ? -1 : 1);
    return moved === undefined ? { value, cursor, changed: false } : { value, cursor: moved, changed: true };
  }
  if (key === '\u001bb') return { value, cursor: previousWordIndex(value, cursor), changed: true };
  if (key === '\u001bf') return { value, cursor: nextWordIndex(value, cursor), changed: true };
  if (key === '\u007f' || key === '\b') {
    if (cursor <= 0) return { value, cursor, changed: true };
    return remove(previousCharacterIndex(value, cursor), cursor);
  }
  if (key === '\u0017' || key === '\u001b\u007f') return remove(previousWordIndex(value, cursor), cursor);
  // Kill to the start / end of the current line. On an empty remainder Ctrl+K
  // joins the next line, as it does in readline and emacs.
  if (key === '\u0015') return remove(lineStartIndex(value, cursor), cursor);
  if (key === '\u000b') {
    const end = lineEndIndex(value, cursor);
    return remove(cursor, end === cursor ? Math.min(value.length, cursor + 1) : end);
  }
  if (key === '\u0001') return { value, cursor: lineStartIndex(value, cursor), changed: true };
  if (key === '\u0005') return { value, cursor: lineEndIndex(value, cursor), changed: true };
  if (key === '\u001b[3~' || key === '\u0004') {
    if (cursor >= value.length) return { value, cursor, changed: true };
    return remove(cursor, nextCharacterIndex(value, cursor));
  }
  if (!key.startsWith('\u001b') && !/[\u0000-\u001f\u007f]/.test(key)) return insert(key);
  return { value, cursor, changed: false };
}
export const editComposer = editWaitingComposer;

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

export function commandPaletteMatches(
  value: string,
  commands: readonly PickerOption<string>[],
): readonly PickerOption<string>[] {
  return value.startsWith('/') && !value.includes(' ')
    ? commands.filter((option) => option.value.startsWith(value))
    : [];
}

export function composerRightArrowValue(
  value: string, hasPaletteOptions: boolean, opensPalette = false,
): string | undefined {
  return opensPalette && !value && !hasPaletteOptions ? '/' : undefined;
}

export function pickerConfirmsSelection(key: string): boolean {
  return key === '\r' || key === '\n' || key === '\u001b[C';
}

export function pickerDeletesSelection(key: string): boolean {
  return key === '\u001b[3~';
}

/** Fill a terminal-width rule from the left and pin a short label to its
 * right edge. Both composer borders use this same layout: usage above and
 * the conversation title below. */
export function rightLabeledRule(width: number, label?: string): string {
  const suffix = label ? ` ${visibleSlice(label, Math.max(0, width - 4))}` : '';
  return `${'─'.repeat(Math.max(0, width - terminalCellWidth(suffix)))}${suffix}`;
}

/** `commitThrough` is where provisional content begins: the live assistant and
 * any queued turns. Those rows are drawn from state that is about to change --
 * a queued turn becomes a real user message the moment it is sent -- so
 * promoting them into native scrollback paints them a second time when they
 * become real, stranding the first copy above the running turn's own output.
 * Native scrollback may only ever receive rows that are already persisted. */
export function inlineConversationPlan(
  permanent: readonly string[], current: readonly string[], commit: boolean, maxDynamic: number,
  promoteThrough = permanent.length, commitThrough = current.length,
): { reset: boolean; dynamic: string[]; permanent: string[] } {
  const prefixMatches = permanent.every((line, index) => current[index] === line);
  // A transient state can briefly omit the pending assistant between
  // stopWaiting() and the authoritative persisted render. Never erase real
  // scrollback for that intermediate frame; the next commit reconciles it.
  if (!prefixMatches && !commit) {
    return { reset: false, dynamic: [], permanent: [...permanent] };
  }
  const previous = prefixMatches ? [...permanent] : [];
  const overflowBoundary = Math.max(previous.length, current.length - Math.max(0, maxDynamic));
  const promotedBoundary = Math.min(promoteThrough, overflowBoundary);
  const committed = Math.max(previous.length, Math.min(commitThrough, current.length));
  const nextPermanent = commit
    ? current.slice(0, committed)
    : current.slice(0, Math.max(previous.length, Math.min(promotedBoundary, commitThrough)));
  const uncommitted = commit ? current.slice(committed) : current.slice(previous.length);
  return {
    reset: !prefixMatches,
    dynamic: uncommitted.slice(-Math.max(0, maxDynamic)),
    permanent: nextPermanent,
  };
}

/** A reset starts at the terminal home position. Fill only the unused rows
 * above the frame so its footer/composer remains attached to the viewport's
 * bottom edge without turning those blank rows into persisted transcript. */
export function bottomAnchoredLines(lines: readonly string[], height: number): string[] {
  return [...Array.from({ length: Math.max(0, height - lines.length) }, () => ''), ...lines];
}

/** Retained for callers and tests that reason about a bottom-anchored viewport;
 * the prompter itself now repaints cursor-relative (see inlineFrameDiff).
 *
 * Absolute viewport geometry for an incremental repaint. Completed prefix
 * rows stay above the new live region; growth scrolls only enough rows to
 * make that possible. The live region itself always starts at the row that
 * makes its final row equal the terminal's bottom row. */
export function bottomAnchoredFrameGeometry(
  height: number, previousDynamicRows: number, permanentRows: number, dynamicRows: number,
): { scrollRows: number; clearStartRow: number; dynamicStartRow: number } {
  const viewportHeight = Math.max(1, height);
  const dynamicStartRow = dynamicRows ? Math.max(1, viewportHeight - dynamicRows + 1) : viewportHeight;
  if (!previousDynamicRows) return { scrollRows: 0, clearStartRow: dynamicStartRow, dynamicStartRow };
  const previousStartRow = Math.max(1, viewportHeight - previousDynamicRows + 1);
  const scrollRows = Math.max(0, previousStartRow + permanentRows - dynamicStartRow);
  const clearStartRow = Math.min(dynamicStartRow, previousStartRow - scrollRows + permanentRows);
  return { scrollRows, clearStartRow: Math.max(1, clearStartRow), dynamicStartRow };
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
export function conversationMessageWindow<T>(
  persisted: readonly T[], transient: T | undefined, queued: readonly T[], historyLimit = 40,
): { messages: T[]; messageStart: number } {
  const history = persisted.slice(-Math.max(0, historyLimit));
  return {
    messages: [...history, ...(transient === undefined ? [] : [transient]), ...queued],
    messageStart: persisted.length - history.length,
  };
}

export type InlineResponseEvent =
  | { kind: 'activity'; responseOffset: number; sequence?: number; lines: string[] }
  | { kind: 'steer'; responseOffset: number; sequence?: number; text: string };
export type ResponseTimelinePart = { kind: 'markdown'; block: MessageBlock } | InlineResponseEvent;
export type ActivityEntry = { anchor: number; responseOffset?: number; sequence?: number; event?: HarnessActivityEvent; lines: string[] };
/** `viewport` repaints one screen (a width change re-wraps every row, so what
 * is on screen is wrong, but re-dumping the transcript on every resize would
 * flood scrollback). `history` writes the whole windowed transcript once: the
 * first frame of a process and the first frame of a newly opened session. */
export type InlineReset = false | 'viewport' | 'history';
type InlineFrameState = {
  permanent: string[]; dynamic: string[]; cursorRow: number; cursorColumn: number; reset: InlineReset; hideCursor: boolean;
  targetHeight: number;
};

/** Cursor-relative repaint of the live region. `previous` is what the last
 * frame left on screen with the cursor parked on `previousCursorRow` of it;
 * `appended` are rows entering permanent scrollback directly above the new
 * live rows. Nothing here addresses an absolute screen row, so the region can
 * start wherever the shell left the cursor and the terminal scrolls naturally
 * when the content reaches its bottom edge.
 *
 * Rows are compared, not blindly rewritten: a spinner tick touches one row. A
 * height change erases only from the first differing row down -- never the
 * viewport -- and rows promoted into scrollback that are already on screen as
 * the head of the old live region are simply left where they are. */
export function inlineFrameDiff(
  previous: readonly string[], previousCursorRow: number, appended: readonly string[], dynamic: readonly string[],
  cursorRow: number, cursorColumn: number,
): string {
  const next = [...appended, ...dynamic];
  let out = '';
  let row = Math.max(0, previousCursorRow);
  const moveTo = (target: number): void => {
    if (target < row) out += `\u001b[${row - target}A`;
    else if (target > row) out += `\u001b[${target - row}B`;
    row = target;
  };
  if (next.length === previous.length) {
    for (const [index, line] of next.entries()) {
      if (line === previous[index]) continue;
      moveTo(index);
      out += `\r\u001b[2K${line}`;
    }
  } else {
    let common = 0;
    while (common < previous.length && common < next.length && previous[common] === next[common]) common += 1;
    if (common < previous.length) {
      moveTo(common);
      out += '\r\u001b[J';
      for (let index = common; index < next.length; index++) {
        if (index > common) { out += '\n'; row += 1; }
        out += `\r\u001b[2K${next[index]}`;
      }
    } else {
      // Pure growth below unchanged rows: newlines from the old last row are
      // what let the terminal scroll on its own when the bottom is reached.
      moveTo(Math.max(0, previous.length - 1));
      for (let index = common; index < next.length; index++) {
        if (index > 0) { out += '\n'; row += 1; }
        out += `\r\u001b[2K${next[index]}`;
      }
    }
  }
  moveTo(appended.length + Math.max(0, Math.min(cursorRow, Math.max(0, dynamic.length - 1))));
  return `${out}\u001b[${Math.max(1, cursorColumn)}G`;
}


/** One provider may publish pending/running/progress frames for the same tool.
 * They describe one lifecycle, not separate calls. Upsert by native id, or by
 * the latest still-open matching label when a protocol omits ids. */
export function upsertActivityEvent(
  entries: readonly ActivityEntry[], anchor: number, responseOffset: number | undefined, event: HarnessActivityEvent, sequence?: number,
): ActivityEntry[] {
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
  // full-screen reset. responseTimeline applies a bounded visual summary
  // without destroying the chronological source data.
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
export function activityLifecyclePhase(
  activeTools: ReadonlyMap<string, string>, event: HarnessActivityEvent,
): { activeTools: Map<string, string>; phase: string } {
  const next = new Map(activeTools);
  const key = event.id ?? event.label;
  if (event.kind === 'tool-start') next.set(key, event.label);
  else if (event.kind === 'tool-done' || event.kind === 'tool-error') {
    if (!next.delete(key) && !event.id) {
      const matchingKey = [...next].reverse().find(([, label]) => label === event.label)?.[0];
      if (matchingKey) next.delete(matchingKey);
    }
  }
  const running = [...next.values()];
  return { activeTools: next, phase: running.length ? `running ${running[running.length - 1]}` : 'thinking' };
}

export function transientAssistantRequired(
  liveResponse: string, waiting: boolean, transcriptLength: number, entries: readonly ActivityEntry[],
): boolean {
  return Boolean(liveResponse || (waiting && entries.some((entry) =>
    entry.anchor === transcriptLength && entry.responseOffset !== undefined)));
}

/** Parse the response exactly once, then attach tools and steering messages to
 * the first complete Markdown block boundary at or after their raw response
 * offset. This preserves chronology without cutting a fence, emphasis span,
 * link, list, quote, or table into independently parsed fragments. */
export function responseTimeline(
  content: string, events: readonly InlineResponseEvent[], parsedBlocks?: readonly MessageBlock[],
): ResponseTimelinePart[] {
  // `parsedBlocks` lets the live message supply its incrementally parsed
  // blocks; they are identical to splitIntoBlocks(content) by contract.
  const blocks = parsedBlocks ?? splitIntoBlocks(content);
  const sorted = [...events].sort((left, right) => left.responseOffset - right.responseOffset
    || (left.sequence ?? 0) - (right.sequence ?? 0));
  // No tool row is ever collapsed into a "… N earlier tool calls" count, at
  // either the response or the burst level. Such a row's text changes every
  // time another tool runs, and a row that can still change cannot enter
  // native scrollback -- so it pinned itself, and every paragraph after it, in
  // the repainted region directly above the composer for the rest of the turn.
  // Each finished tool is instead one immutable row at the offset where it
  // started, so tools and prose stay interleaved in the order they happened
  // and scroll away together. Overall height is bounded where it actually
  // matters, by renderActivityLine capping one tool's own output preview and
  // by inlineConversationPlan promoting overflow out of the live region.
  const slots: InlineResponseEvent[][] = Array.from({ length: blocks.length + 1 }, () => []);
  for (const event of sorted) {
    const blockIndex = event.responseOffset <= 0 ? -1
      : blocks.findIndex((block) => event.responseOffset <= block.sourceEnd);
    slots[blockIndex < 0 ? (event.responseOffset <= 0 ? 0 : blocks.length) : blockIndex + 1]!.push(event);
  }
  const parts: ResponseTimelinePart[] = [];
  parts.push(...slots[0]!);
  for (const [index, block] of blocks.entries()) {
    parts.push({ kind: 'markdown', block });
    parts.push(...slots[index + 1]!);
  }
  return parts;
}

/** The final parsed block at a live EOF can still grow on the next token. It
 * is safe to freeze only when later Markdown proves the parser closed it, or
 * when an explicit blank line closes the source construct. An out-of-band
 * tool event alone is not proof that a list/paragraph/fence is complete. */
export function streamingMarkdownBoundary(
  content: string, timeline: readonly ResponseTimelinePart[], index: number,
): boolean {
  const part = timeline[index];
  if (part?.kind !== 'markdown' || !part.block.blockBoundary) return false;
  if (timeline.slice(index + 1).some((candidate) => candidate.kind === 'markdown')) return true;
  return /\n[ \t]*\n$/.test(content.slice(0, part.block.sourceEnd));
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
  private activeTools = new Map<string, string>();
  private liveResponse = '';
  private responsePaintTimer?: NodeJS.Timeout;
  private frameInFlight = false;
  private pendingInlineFrame?: InlineFrameState;
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
  /** Persisted conversation lines already emitted into the terminal's native
   * scrollback. Only the changing response/composer below them is repainted. */
  private inlinePermanentLines: string[] = [];
  private inlineWrittenPermanentLines: string[] = [];
  /** Exactly the live rows the last flushed frame left on screen, and the row
   * of them the cursor was parked on. Every repaint is relative to these. */
  private inlinePaintedRows: string[] = [];
  private inlinePaintedCursorRow = 0;
  private inlineStarted = false;
  private lastColumns = output.columns || 0;
  private commitConversationOnNextPaint = false;
  private resetInlineScreen: InlineReset = 'history';
  private usageLabel?: string;
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
  /** Laid-out rows of settled messages, keyed by everything that shapes them.
   * A spinner tick or a keystroke repaints with forty cache hits instead of
   * re-parsing and re-wrapping forty messages. */
  private readonly messageRowCache = new LruCache<string, readonly string[]>(256);
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
      // Only a width change invalidates what is on screen (every row re-wraps).
      // A height change leaves the rows around the cursor intact, so the
      // ordinary cursor-relative repaint is still correct -- unless the old
      // live region no longer fits, when its top is off screen and unreachable.
      const columns = output.columns || 0;
      const widthChanged = columns !== this.lastColumns;
      this.lastColumns = columns;
      if (widthChanged || this.inlinePaintedRows.length > (output.rows || 30)) {
        this.resetInlineScreen = this.resetInlineScreen || 'viewport';
        this.commitConversationOnNextPaint = true;
      }
      this.paint(this.draft, this.draftOptions, this.draftSelected, this.draftPrompt, this.draftCursor, this.draftPalette);
    }
  };

  constructor() {
    // Nothing is cleared. The user's scrollback and whatever the shell printed
    // above are theirs; the first frame simply begins at the cursor. (`3J`
    // here used to wipe the terminal's entire scrollback on launch.)
    output.write('\u001b[?25h');
    process.on('SIGWINCH', this.onResize);
    // Any exit path -- process.exit() deep in a command, an uncaught error, a
    // signal handler elsewhere -- must not leave the shell in raw mode with a
    // hidden cursor and bracketed paste on.
    process.on('exit', restoreTerminal);
    terminalModes.leaveLiveRegion = () => this.eraseLiveRegion();
  }

  render(session: HarnessSession, account?: string, notice?: string): void {
    if (this.currentSession?.id !== session.id) {
      this.activityEntries = [];
      this.inlinePermanentLines = [];
      this.resetInlineScreen = 'history';
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
    this.commitConversationOnNextPaint = true;
    this.paint('', [], 0, '› ', 0);
  }

  response(text: string, mode: 'append' | 'replace' = 'append'): void {
    // An empty replacement is meaningful when a failed streaming attempt is
    // about to retry on another account. Appends with no content remain a
    // no-op, but replace must clear the obsolete partial response.
    if (!text && mode === 'append') return;
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
      ...(this.waitingLabel ? { sequence: ++this.timelineSequence } : {}),
      lines: [normalized],
    }];
    this.schedulePaint();
  }

  activityEvent(event: HarnessActivityEvent): void {
    const anchor = this.waitingLabel ? this.activityAnchor : this.currentSession ? sessionTranscriptMessages(this.currentSession).length : 0;
    const responseOffset = this.waitingLabel ? this.liveResponse.length : undefined;
    this.activityEntries = upsertActivityEvent(this.activityEntries, anchor, responseOffset, event, ++this.timelineSequence);
    const lifecycle = activityLifecyclePhase(this.activeTools, event);
    this.activeTools = lifecycle.activeTools;
    this.phase(lifecycle.phase);
    this.schedulePaint();
  }

  panel(title: string, body: string): void {
    const lines = body.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    this.activityEntries = [{ anchor: this.currentSession ? sessionTranscriptMessages(this.currentSession).length : 0, lines: [chalk.bold(title), ...lines].slice(-6) }];
    this.activityAnchor = this.currentSession ? sessionTranscriptMessages(this.currentSession).length : 0;
    this.paint(this.draft, this.draftOptions, this.draftSelected, this.draftPrompt, this.draftCursor);
  }

  startWaiting(
    message: string,
    onCancel?: (restoreDraft: boolean) => void,
    onSubmit?: (text: string) => Promise<LiveTurnInputResult>,
  ): void {
    this.stopWaiting(false);
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
    this.waitingCancelled = false;
    this.waitingFrame = 0;
    this.waitingStartedAt = Date.now();
    this.turnUsage = undefined;
    if (input.isTTY) {
      const listen = (): void => {
        input.setRawMode(true);
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
    if (input.isTTY) input.setRawMode(false);
    this.cancelWaiting = undefined;
    this.waitingSubmit = undefined;
    this.waitingCancelled = false;
    this.settleApprovals();
    this.waitingLabel = '';
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

  usage(label?: string): void {
    if (this.usageLabel === label) return;
    this.usageLabel = label;
    this.schedulePaint();
  }

  private statusText(): string {
    const session = this.currentSession;
    if (!session) return '';
    const context = compactPath(session.workspace ?? process.cwd());
    const provider = sessionProviderLabel(session);
    const harness = session.nativeHarness ? localHarnessForCommand(session.nativeHarness) : undefined;
    const rawModel = harness?.modelArgvPrefix ? session.model ?? 'automatic' : undefined;
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
    return `${chalk.cyanBright(waitingSpinnerGlyph(this.reducedMotion ? 0 : this.waitingFrame))}  ${chalk.dim(label)}`;
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
    // No -1 margin: DEC autowrap is off for this whole frame (see the
    // `[?7l` at the top of it), so the real last column is safe to
    // use, not just columns-1.
    const width = Math.max(12, output.columns || 100);
    const inner = width - 4;
    // The conversation transcript gets its own, tighter margin: a bare
    // marker-and-space (2 columns) instead of inner's extra 2-space wrapper
    // on top of its own 4-column reservation (6 total) -- next to a native
    // CLI's own output, which runs close to the full terminal width with
    // only a bullet-and-space margin, ClikCode's wider gutter read as
    // noticeably narrower and "bleaker" for no real reason; this doesn't
    // touch inner itself, so the notice/composer/meta lines below (which
    // share it) are unaffected.
    const conversationInner = width - 2;
    const rule = chalk.dim('─'.repeat(width));
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
    const transientAssistant = hasTransientAssistant
      ? { role: 'assistant' as const, content: this.liveResponse }
      : undefined;
    const storedQueued = session.queuedTurns ?? [];
    const queuedMessages = [
      ...storedQueued.map((item) => ({ role: 'user' as const, content: item.text, queueState: 'queued' as const })),
      ...this.waitingSubmissions.filter((item) => item.state !== 'steered')
        .map((item) => ({ role: 'user' as const, content: item.text, queueState: item.state })),
    ];
    // 40, not 6: matches the same replay/adoption cap used elsewhere
    // (failoverPrompt, ADOPTED_TRANSCRIPT_LIMIT) and — now that the
    // conversation area supports scrolling — gives Page Up somewhere real to
    // go instead of a pool too small to scroll through at all. Transient and
    // queued rows sit outside that cap so they cannot shift the persisted
    // prefix while a turn is streaming.
    const { messages, messageStart } = conversationMessageWindow<{
      role: 'user' | 'assistant'; content: string; queueState?: string;
    }>(persistedMessages, transientAssistant, queuedMessages);
    // The final status row is written without a trailing newline, so using
    // the complete terminal height is safe and important: leaving one row
    // unpainted allowed an obsolete status line to remain visibly duplicated.
    const targetHeight = Math.max(5, output.rows || 30);
    const requestedPaletteCapacity = palette?.capacity ?? (options.length ? Math.min(options.length, 8) + 2 : 0);
    // Keep generation at the response's live edge, directly above the
    // composer. It is a fixed status band, not transcript content, so a long
    // streamed answer cannot scroll it away. Optional bands share only the
    // rows left after one composer row and its three fixed footer rows.
    const waitingRows = this.waitingLabel && targetHeight >= 5 ? 1 : 0;
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
    const maxComposerRows = Math.max(1, targetHeight - 3 - paletteRows - noticeRows - waitingRows - approvalRows.length);
    const composerRows = composerLayout(composer, cursor, composerWidth, maxComposerRows);
    const conversation: Array<{ text: string }> = [];
    let stableConversationBoundary = 0;
    // Where provisional rows begin. The live assistant and any queued turns are
    // drawn from state that is about to change -- a queued turn becomes a real
    // user message the moment it is sent -- so they must stay in the repainted
    // region until they are persisted, never in native scrollback.
    let provisionalConversationStart = Number.POSITIVE_INFINITY;
    // Rows of a still-open block that can no longer change: everything above
    // the final Markdown part, plus every completed source line of an open code
    // fence. Without this only a CLOSED block could leave the live region, so a
    // code block taller than the viewport showed just its tail while streaming
    // and its head rows never reached scrollback at all.
    let lineStableConversationBoundary = 0;
    const ensureBlankConversationRow = (): void => {
      if (conversation.length && conversation[conversation.length - 1]?.text !== '') conversation.push({ text: '' });
    };
    const appendActivityGroup = (lines: readonly string[]): void => {
      if (!lines.length) return;
      ensureBlankConversationRow();
      for (const activity of lines) {
        conversation.push({ text: `${chalk.dim('·')} ${visibleSlice(activity, Math.max(1, conversationInner - 2))}` });
      }
      ensureBlankConversationRow();
    };
    const appendActivity = (anchor: number): void => {
      const lines = this.activityEntries
        .filter((item) => item.anchor === anchor && item.responseOffset === undefined)
        .flatMap((entry) => entry.lines);
      appendActivityGroup(lines);
    };
    appendActivity(messageStart);
    for (const [messageIndex, message] of messages.entries()) {
      const marker = message.role === 'assistant' ? chalk.white('·') : chalk.white('›');
      const appendMarkdownContent = (
        rawContent: string, messageMarker: string, events: readonly InlineResponseEvent[] = [], trackStableTail = false,
      ): void => {
        // Model and user text is sanitized before it is parsed or styled, so
        // the live stream and the persisted copy of a message lay out alike.
        const content = sanitizeTerminalText(rawContent);
        // Settled content is context-free: a message always starts after a
        // blank row (or at the top), so its rows depend only on these inputs.
        const cacheKey = trackStableTail ? undefined : [
          conversationInner, messageMarker,
          events.map((event) => `${event.kind}@${event.responseOffset}#${event.sequence ?? ''}=${event.kind === 'activity' ? event.lines.join('\n') : event.text}`).join('\u0001'),
          content,
        ].join('\u0000');
        const cachedRows = cacheKey === undefined ? undefined : this.messageRowCache.get(cacheKey);
        if (cachedRows) {
          for (const text of cachedRows) conversation.push({ text });
          return;
        }
        const firstRow = conversation.length;
        let firstLine = true;
        /** Returns how many conversation rows are final even if this block is
         * still growing at the end of a live stream. */
        const appendBlock = (block: MessageBlock, live = false): number => {
          const blockStart = conversation.length;
          const quotePrefix = block.quoteDepth ? chalk.dim('│ '.repeat(block.quoteDepth)) : '';
          const linePrefix = (): string => {
            const prefix = firstLine ? `${messageMarker} ` : '  ';
            firstLine = false;
            return prefix;
          };
          if (block.kind === 'code') {
            const structural = `${quotePrefix}${'  '.repeat(block.indent)}`;
            let lastLineStart = blockStart;
            for (const codeLine of [...(block.language ? [chalk.dim(`[${block.language}]`)] : []), ...block.lines]) {
              lastLineStart = conversation.length;
              const segments = wrapCodeLine(codeLine, Math.max(1, conversationInner - terminalCellWidth(structural) - 2));
              for (const [segmentIndex, segment] of segments.entries()) {
                const continuation = segmentIndex ? chalk.dim('↳ ') : '  ';
                conversation.push({ text: `${linePrefix()}${structural}${continuation}${chalk.cyan(segment)}` });
              }
            }
            // The last source line may still be receiving characters, and a
            // fence with no body yet may still be receiving its info string.
            return block.lines.length > 1 || block.lines[0] ? lastLineStart : blockStart;
          }
          if (block.kind === 'table') {
            const available = Math.max(1, conversationInner - terminalCellWidth(quotePrefix));
            for (const tableLine of renderTableBlock(block.header, block.rows, available, block.align)) {
              conversation.push({ text: `${linePrefix()}${quotePrefix}${tableLine}` });
            }
            // A new row can re-layout every column, so no table row is final
            // until the block closes. All of them are written at that point.
            return blockStart;
          }
          if (block.kind === 'rule') {
            const available = Math.max(1, conversationInner - terminalCellWidth(quotePrefix));
            conversation.push({ text: `${linePrefix()}${quotePrefix}${chalk.dim('─'.repeat(available))}` });
            return blockStart;
          }
          const listPrefix = block.kind === 'list-item'
            ? `${'  '.repeat(block.depth)}${block.task ? chalk.cyan(block.checked ? '☑' : '☐') : block.ordered ? chalk.dim(`${block.number}.`) : chalk.dim('•')} `
            : block.kind === 'paragraph' ? '  '.repeat(block.indent) : '';
          const structural = `${quotePrefix}${listPrefix}`;
          const hangIndent = ' '.repeat(terminalCellWidth(structural));
          const text = block.kind === 'heading' || block.kind === 'paragraph' || block.kind === 'list-item' ? block.text : '';
          // The block still receiving tokens has a new text on every frame;
          // caching it only fills the cache with dead prefixes.
          const styled = (live ? renderInlineMarkdownLive : renderInlineMarkdown)(text || ' ');
          const budget = Math.max(1, conversationInner - terminalCellWidth(structural));
          const wrapped = wrapWords(styled, budget);
          for (const [lineIndex, line] of wrapped.entries()) {
            const indentation = lineIndex === 0 ? structural : hangIndent;
            const rendered = block.kind === 'heading'
              ? block.level <= 2 ? chalk.cyanBright(chalk.bold(line)) : chalk.bold(line)
              : line;
            conversation.push({ text: `${linePrefix()}${indentation}${rendered}` });
          }
          return blockStart;
        };
        const timeline = responseTimeline(content, events, trackStableTail ? this.streamingBlocks(content) : undefined);
        let finalMarkdownPart = -1;
        for (const [partIndex, part] of timeline.entries()) if (part.kind === 'markdown') finalMarkdownPart = partIndex;
        for (const [partIndex, part] of timeline.entries()) {
          if (part.kind === 'markdown') {
            const stableRows = appendBlock(part.block, trackStableTail && partIndex === finalMarkdownPart);
            if (trackStableTail && partIndex === finalMarkdownPart) lineStableConversationBoundary = stableRows;
          } else if (part.kind === 'activity') appendActivityGroup(part.lines);
          else {
            ensureBlankConversationRow();
            appendMarkdownContent(part.text, chalk.white('›'));
            conversation.push({ text: `  ${chalk.dim('↳ steered into active turn')}` });
            ensureBlankConversationRow();
          }
          // Everything before the final live timeline part is structurally
          // complete. It can enter native scrollback if the replaceable tail
          // would otherwise exceed the viewport; the unfinished last block
          // remains editable as more streamed Markdown arrives.
          if (trackStableTail && streamingMarkdownBoundary(content, timeline, partIndex)) {
            stableConversationBoundary = conversation.length;
          }
        }
        if (cacheKey !== undefined) this.messageRowCache.set(cacheKey, conversation.slice(firstRow).map((row) => row.text));
      };
      const absoluteMessageIndex = messageStart + messageIndex;
      // Tool rows describe an assistant turn. They are anchored at the index the
      // live assistant occupied, and the NEXT question lands on that same index
      // once the answer is persisted -- so without this the finished tools from
      // the previous answer rendered inside the question just typed, directly
      // above the composer, on every single turn.
      const embeddedEvents: InlineResponseEvent[] = (message.role !== 'assistant' ? [] : this.activityEntries)
        .filter((entry) => entry.anchor === absoluteMessageIndex && entry.responseOffset !== undefined)
        // A tool that is still running is reported in the waiting band
        // ("running <label>") and nowhere else. Its row is still mutable --
        // completion rewrites it with the output preview -- so rendering it
        // here forced it, and everything after it, to stay in the repainted
        // region. Because the row is anchored at the offset where the tool
        // STARTED, one long-running (or never-completed) tool parked its own
        // row and every later paragraph directly above the composer for the
        // rest of the turn. A finished row is immutable and flows into
        // scrollback with the text around it.
        .filter((entry) => entry.event?.kind !== 'tool-start')
        .map((entry) => ({
          kind: 'activity' as const, responseOffset: entry.responseOffset!, sequence: entry.sequence, lines: entry.lines,
        }));
      if (absoluteMessageIndex === persistedMessages.length) {
        const durableSteers = pending?.steers ?? [];
        embeddedEvents.push(...durableSteers.map((item) => ({
          kind: 'steer' as const, responseOffset: item.responseOffset ?? 0, text: item.text,
        })));
        const durableTexts = new Set(durableSteers.map((item) => item.text));
        embeddedEvents.push(...this.waitingSubmissions.filter((item) => item.state === 'steered'
          && !durableTexts.has(item.text))
          .map((item) => ({ kind: 'steer' as const, responseOffset: item.responseOffset, sequence: item.sequence, text: item.text })));
      }
      const transientAssistant = hasTransientAssistant && absoluteMessageIndex === persistedMessages.length;
      appendMarkdownContent(message.content, marker, embeddedEvents, transientAssistant);
      if (message.queueState) {
        const status = message.queueState === 'steered' ? 'steered into active turn'
          : message.queueState === 'sending' ? 'submitting…'
            : message.queueState === 'error' ? 'not sent · restored for editing' : 'queued for next turn';
        conversation.push({ text: `  ${chalk.dim(`↳ ${status}`)}` });
      }
      ensureBlankConversationRow();
      appendActivity(messageStart + messageIndex + 1);
      // Only QUEUED rows are provisional. The live assistant is re-rendered
      // identically once persisted, so its settled prefix may still spill into
      // scrollback -- which is what keeps an answer taller than the viewport
      // from losing its head rows while it streams.
      if (absoluteMessageIndex + 1 === persistedMessages.length + (hasTransientAssistant ? 1 : 0)) {
        provisionalConversationStart = conversation.length;
      }
    }
    const conversationLines = liveConversationLines(
      conversation.map((row) => row.text), hasTransientAssistant,
    );
    const meta = this.statusText();
    const footer: string[] = [];
    if (noticeRows && notice) footer.push(`  ${chalk.yellow(visibleSlice(notice, inner))}`);
    if (paletteCapacity) {
      footer.push(rule);
      const visibleRows = paletteCapacity - 2;
      const start = Math.max(0, Math.min(selected - Math.floor(visibleRows / 2), options.length - visibleRows));
      const windowed = options.slice(start, start + visibleRows);
      windowed.forEach((option, index) => {
        const absoluteIndex = start + index;
        const selectedOption = absoluteIndex === selected;
        const available = Math.max(1, width - 4);
        const label = visibleSlice(option.label, available);
        const remaining = available - terminalCellWidth(label);
        const detail = option.detail && remaining > 3 ? visibleSlice(option.detail, remaining - 2) : '';
        footer.push(`  ${selectedOption ? chalk.cyan('❯') : ' '} ${selectedOption ? chalk.bold(label) : label}${detail ? `  ${chalk.dim(detail)}` : ''}`);
      });
      for (let index = windowed.length; index < visibleRows; index++) footer.push('');
      footer.push(`  ${chalk.dim(visibleSlice(palette?.hint ?? '↑↓ select · Tab complete · Enter run', width - 2))}`);
    }
    footer.push(...approvalRows);
    if (waitingRows) {
      footer.push(`  ${visibleSlice(this.waitingLine(), Math.max(1, inner))}`);
    }
    // Usage lives on the upper composer border, mirroring the title on the
    // lower border. Keeping it out of the provider/model/directory row makes
    // the two quota windows easy to scan without adding another footer row.
    footer.push(chalk.dim(rightLabeledRule(width, this.usageLabel)));
    const composerStart = footer.length;
    for (const [index, row] of composerRows.rows.entries()) {
      footer.push(`  ${index === 0 ? chalk.white(prompt) : ' '.repeat(terminalCellWidth(prompt))}${row}`);
    }
    // The rule below the composer carries the chat's title at its right
    // edge instead of a plain dashed line -- dashes fill from the left up to
    // wherever the title starts, so a longer title just eats more of the
    // rule rather than needing a line of its own. Provider/model/directory
    // (meta) stay on their own separate line below, never sharing space with
    // the title the way they used to.
    footer.push(chalk.dim(rightLabeledRule(width, this.titleText())));
    footer.push(`  ${chalk.dim(visibleSlice(meta, inner))}`);

    // A width change mid-turn re-wraps rows that are already permanent, so the
    // old prefix can never match again. Committing the half-streamed answer to
    // force a match froze it, and every later frame was then rejected as a
    // mismatch -- the answer vanished until the turn ended. Re-plan from an
    // empty prefix instead: stable rows are promoted again as they overflow,
    // and the viewport reset below repaints one screen either way.
    const replanLiveTurn = this.resetInlineScreen === 'viewport' && hasTransientAssistant;
    if (replanLiveTurn) this.inlinePermanentLines = [];
    const commit = this.commitConversationOnNextPaint && !replanLiveTurn;
    const maxDynamicConversation = Math.max(0, targetHeight - footer.length);
    // With no queued row on screen there is nothing provisional, so the whole
    // conversation is committable.
    const provisionalStart = Number.isFinite(provisionalConversationStart)
      ? provisionalConversationStart : conversationLines.length;
    const plan = inlineConversationPlan(
      this.inlinePermanentLines, conversationLines, commit, maxDynamicConversation,
      commit ? conversationLines.length : Math.max(stableConversationBoundary, lineStableConversationBoundary),
      Math.min(provisionalStart, conversationLines.length),
    );
    const reset: InlineReset = this.resetInlineScreen || (plan.reset ? 'viewport' : false);
    const dynamicConversation = plan.dynamic;
    const dynamic = [...dynamicConversation, ...footer];
    const cursorRow = palette?.hideCursor
      ? Math.max(0, dynamic.length - 1)
      : dynamicConversation.length + composerStart + composerRows.cursorRow;
    const cursorColumn = palette?.hideCursor ? 1 : 3 + terminalCellWidth(prompt) + composerRows.cursorWidth;
    this.inlinePermanentLines = plan.permanent;
    this.commitConversationOnNextPaint = false;
    this.resetInlineScreen = false;
    this.writeInlineFrame(plan.permanent, dynamic, cursorRow, cursorColumn, reset, Boolean(palette?.hideCursor), targetHeight);
  }

  /** Native-scrollback renderer. Persisted chat is emitted once; only the
   * live response and footer are erased and replaced. This lets the terminal,
   * rather than a private viewport offset, own wheel and touch scroll. */
  private writeInlineFrame(
    permanent: readonly string[], dynamic: readonly string[], cursorRow: number,
    cursorColumn: number, reset: InlineReset, hideCursor: boolean, targetHeight = Math.max(5, output.rows || 30),
  ): void {
    // Last line of defence: whatever produced a row, the only escape sequences
    // that reach the terminal are SGR colors, and no row contains a control
    // character that would move the cursor out from under the diff.
    const safeRow = (row: string): string => sanitizeTerminalText(row, { keepSgr: true, singleLine: true });
    const state: InlineFrameState = {
      permanent: permanent.map(safeRow), dynamic: dynamic.map(safeRow), cursorRow, cursorColumn, reset, hideCursor, targetHeight,
    };
    if (this.frameInFlight) {
      // A resize/session reset must survive later spinner or token paints
      // that coalesce into this pending slot before the current write drains.
      this.pendingInlineFrame = {
        ...state,
        reset: state.reset === 'history' || this.pendingInlineFrame?.reset === 'history' ? 'history'
          : state.reset || this.pendingInlineFrame?.reset || false,
      };
      return;
    }
    this.flushInlineFrame(state);
  }

  private flushInlineFrame(state: InlineFrameState): void {
    if (this.closed || this.suspended) return;
    const prefixMatches = this.inlineWrittenPermanentLines.every((line, index) => state.permanent[index] === line);
    // A change in the live region's height is NOT a reset. It used to be, and
    // every palette open/close, composer wrap, or waiting-band toggle cleared
    // and repainted the whole viewport. inlineFrameDiff erases only from the
    // first row that actually differs and lets growth scroll naturally.
    const reset: InlineReset = state.reset || (prefixMatches ? false : 'viewport');
    // Synchronized output (DEC 2026): the terminal presents the whole frame at
    // once instead of tearing mid-repaint. Terminals without it ignore the pair.
    let frame = `${BEGIN_SYNCHRONIZED_UPDATE}\u001b[?25l\u001b[?7l\r`;
    if (reset === 'viewport') {
      // `2J` clears the viewport only, and only rows this UI is about to
      // repaint. Scrollback is never cleared by this UI.
      frame += '\u001b[2J\u001b[H';
      // Exactly one viewport, bottom-anchored. Emitting the whole retained
      // prefix would re-dump the transcript into scrollback on every resize.
      const rows = bottomAnchoredLines([...state.permanent, ...state.dynamic], state.targetHeight).slice(-state.targetHeight);
      frame += inlineFrameDiff([], 0, rows.slice(0, rows.length - state.dynamic.length), state.dynamic, state.cursorRow, state.cursorColumn);
    } else if (reset === 'history') {
      // The first frame of the process begins at the cursor, below whatever
      // the shell already printed. A newly opened session first removes the
      // old live region and scrolls the previous conversation up into
      // scrollback -- preserved, not erased -- so the new one starts on a
      // clean viewport. Either way the windowed history is written once.
      if (this.inlineStarted) {
        const up = this.inlinePaintedCursorRow;
        frame += `${up > 0 ? `\u001b[${up}A` : ''}\r\u001b[J\u001b[${state.targetHeight};1H${'\n'.repeat(state.targetHeight)}\u001b[H`;
      }
      frame += inlineFrameDiff([], 0, state.permanent, state.dynamic, state.cursorRow, state.cursorColumn);
    } else {
      frame += inlineFrameDiff(
        this.inlinePaintedRows, this.inlinePaintedCursorRow,
        state.permanent.slice(this.inlineWrittenPermanentLines.length), state.dynamic, state.cursorRow, state.cursorColumn,
      );
    }
    frame += `\u001b[?7h${state.hideCursor ? '' : '\u001b[?25h'}${END_SYNCHRONIZED_UPDATE}`;
    this.frameInFlight = true;
    terminalModes.painted = true;
    output.write(frame, () => {
      this.inlineWrittenPermanentLines = state.permanent;
      this.inlinePaintedRows = state.dynamic;
      this.inlinePaintedCursorRow = Math.max(0, Math.min(state.cursorRow, Math.max(0, state.dynamic.length - 1)));
      this.inlineStarted = true;
      this.frameInFlight = false;
      const pending = this.pendingInlineFrame;
      this.pendingInlineFrame = undefined;
      if (pending && !this.closed && !this.suspended) this.flushInlineFrame(pending);
    });
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
    this.pendingInlineFrame = undefined;
    if (input.isTTY) input.setRawMode(false);
    terminalModes.rawMode = false;
    output.write(`${this.eraseLiveRegion()}${leaveInputModes()}\u001b[?7h\u001b[?25h`);
    process.once('SIGCONT', this.onContinue);
    process.kill(process.pid, 'SIGTSTP');
  }

  private readonly onContinue = (): void => {
    if (this.closed) return;
    this.suspended = false;
    const columns = output.columns || 0;
    if (columns !== this.lastColumns) {
      this.resetInlineScreen = this.resetInlineScreen || 'viewport';
      this.commitConversationOnNextPaint = true;
    }
    this.lastColumns = columns;
    this.resumeInput?.();
    if (this.waitingLabel) this.paint(this.waitingDraft, [], 0, '› ', this.waitingCursor);
    else this.paint(this.draft, this.draftOptions, this.draftSelected, this.draftPrompt, this.draftCursor, this.draftPalette);
  };

  /** Cursor-relative erase of everything the last frame painted. The cursor is
   * left at column one of the region's first row, which is where the next
   * writer -- a vendor CLI, the shell, or this UI's next frame -- continues. */
  private eraseLiveRegion(): string {
    const up = this.inlinePaintedCursorRow;
    this.inlinePaintedRows = [];
    this.inlinePaintedCursorRow = 0;
    return `${up > 0 ? `\u001b[${up}A` : ''}\r\u001b[J`;
  }

  /** Remove a completed palette/picker as one frame. Painting an empty
   * composer here left its borders/status rows alive while the selected slash
   * command ran, which looked like a composer floating above blank space. */
  private clearInteractiveFrame(): void {
    this.writeInlineFrame(this.inlinePermanentLines, [], 0, 1, false, true);
  }

  async question(
    prompt: string,
    commands: readonly PickerOption<string>[] = [],
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
          this.paint(value, options, selected, prompt, cursor, { capacity: paletteCapacity });
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
        input.setRawMode(false);
        output.write(`${leaveInputModes()}\u001b[?25h`);
        this.resumeInput = undefined;
        this.clearTransientNotice();
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
        input.setRawMode(false);
        output.write(`${leaveInputModes()}\u001b[?25h`);
        rejectQuestion(Object.assign(new Error('cancelled'), { code: 'ERR_PROMPT_CANCELLED' }));
      };
      const handleKey = (key: string): void => {
        const options = matches();
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
        if (key === '\u001b' && options.length) {
          value = '';
          cursor = 0;
          selected = 0;
          return draw();
        }
        if (key === '\r') {
          const continued = options.length ? undefined : backslashNewline(value, cursor);
          if (continued) { value = continued.value; cursor = continued.cursor; return draw(); }
          if (options.length && value.startsWith('/') && !value.includes(' ')) {
            const command = options[selected].value;
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
          value = options[selected].value;
          cursor = value.length;
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
        // Already handled above when the transcript owns navigation. While a
        // command palette is open, consume these rather than editing text.
        if (key === '\u001b[5~' || key === '\u001b[6~') return;
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
        input.setRawMode(true);
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
          ? `"${query}" - ${visible.length} match${visible.length === 1 ? '' : 'es'} \u00b7 \u2191\u2193 move \u00b7 ${confirmation} choose${secondary}${destructive} \u00b7 \u2190 back \u00b7 Esc exit`
          : `${currentOptions().length} total \u00b7 \u2191\u2193 move \u00b7 ${confirmation} choose${secondary}${destructive} \u00b7 \u2190 back \u00b7 Esc exit \u00b7 type to filter`;
        this.paint(title, renderOptions, selected, '', 0, { capacity, hideCursor: true, hint });
      };
      let finished = false;
      const finish = (value: T | undefined): void => {
        if (finished) return;
        finished = true;
        this.selecting = false;
        stopInput();
        input.setRawMode(false);
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
        input.setRawMode(true);
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
        input.setRawMode(true);
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
        input.setRawMode(true);
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
      input.setRawMode(true);
      input.resume();
      stopInput = listenForTerminalKeys((key) => { if (!finished) handleKey(key); });
      draw();
      void settings?.refresh?.then(() => { if (!finished) draw(); }, () => { if (!finished) draw(); });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pendingInlineFrame = undefined;
    if (this.responsePaintTimer) clearTimeout(this.responsePaintTimer);
    this.responsePaintTimer = undefined;
    this.stopWaiting(false);
    this.clearTransientNotice();
    process.off('SIGWINCH', this.onResize);
    process.off('SIGCONT', this.onContinue);
    process.off('exit', restoreTerminal);
    terminalModes.rawMode = false;
    if (input.isTTY) input.setRawMode(false);
    input.pause();
    // The conversation stays in the terminal's scrollback where the user can
    // still read and copy it. Only this UI's own live region (composer, status
    // rows) is removed, and the shell prompt resumes directly beneath the chat.
    output.write(`${this.eraseLiveRegion()}${leaveInputModes()}\u001b[?7h\u001b[?25h`);
    terminalModes.painted = false;
    terminalModes.leaveLiveRegion = undefined;
  }

  /** Hands the real terminal to a vendor CLI's own interactive flow (typically
   * login) without tearing the session down, so ClikCode's UI can resume in
   * place once that process exits. */
  async suspend(): Promise<void> {
    this.suspended = true;
    this.pendingInlineFrame = undefined;
    if (this.responsePaintTimer) clearTimeout(this.responsePaintTimer);
    this.responsePaintTimer = undefined;
    if (input.isTTY) input.setRawMode(false);
    input.pause();
    // Remove the composer and footer before handing over, so the vendor's
    // output continues directly under the conversation instead of being typed
    // across this UI's status rows.
    output.write(`${this.eraseLiveRegion()}${leaveInputModes()}\u001b[?7h\u001b[?25h`);
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
    // Whatever the vendor printed stays in scrollback and the live region
    // simply starts again below it. Only a width change invalidates the rows
    // this UI wrote earlier, and only that needs the viewport repainted.
    const columns = output.columns || 0;
    if (columns !== this.lastColumns) this.resetInlineScreen = this.resetInlineScreen || 'viewport';
    this.lastColumns = columns;
    this.commitConversationOnNextPaint = true;
    if (input.isTTY) input.resume();
    this.paint(this.draft, this.draftOptions, this.draftSelected, this.draftPrompt, this.draftCursor);
  }
}
