/**
 * Editing the line you are typing: word jumps, vertical movement through a
 * wrapped value, the backslash-newline continuation, and the key table that
 * drives them.
 *
 * Pure string-and-cursor arithmetic, with no terminal in it. Separate from
 * the prompter because what a key does to a line of text is a different
 * question from how that line is drawn.
 */
import { nextCharacterIndex, previousCharacterIndex, terminalCellWidth } from './render/width.js';
import { NEWLINE_KEY, pastedText } from './keys.js';

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
