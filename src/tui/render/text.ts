/** Terminal text as bytes: the escape sequences that may appear in it, and
 * making a string safe to print. */

import { terminalCellWidth } from './width.js';

/** Every escape sequence a terminal acts on. OSC and DCS/SOS/PM/APC bodies end
 * at their terminator or, failing that, at the end of the line: a model that
 * emits an unterminated `ESC ]` must not swallow the rest of its own answer. */
const ESCAPE_SEQUENCE = new RegExp([
  '\\u001b\\][^\\u0007\\u001b\\n]*(?:\\u0007|\\u001b\\\\)?',
  '\\u001b[PX^_][^\\u001b\\n]*(?:\\u001b\\\\)?',
  '(?:\\u001b\\[|\\u009b)[0-?]*[ -/]*[@-~]?',
  '\\u001b[ -/]*[0-~]?',
].join('|'), 'g');

const SGR_SEQUENCE = /^\u001b\[[0-9;]*m$/;

/** The two zero-width sequences this UI writes inside a row: SGR styling and
 * OSC 8 hyperlink open/close. Everything that measures, slices or sanitizes a
 * styled row treats exactly these as atomic and invisible. */
export const OSC8_SEQUENCE = /^\u001b\]8;[^\u0007\u001b\n]*\u001b\\$/;

export const ZERO_WIDTH_SEQUENCES = /\u001b\[[0-9;]*m|\u001b\]8;[^\u0007\u001b\n]*\u001b\\/g;

export const SAFE_LINK = /^(?:https?:\/\/|mailto:)[^\s\u0000-\u001f\u007f-\u009f]+$/i;

const NEEDS_SANITIZING = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\t]/;

const UNSAFE_IN_STYLED_TEXT = /[\u0000-\u0009\u000b-\u001a\u001c-\u001f\u007f-\u009f]|\u001b(?!\[[0-9;]*m|\]8;[^\u0007\u001b\n]*\u001b\\)/;

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export const TAB_WIDTH = 4;

/** Advance each tab to the next tab stop measured from the start of its own
 * line, which is what keeps tab-aligned code aligned. */
export function expandTabs(value: string, tabWidth = TAB_WIDTH): string {
  if (!value.includes('\t')) return value;
  return value.split('\n').map((line) => {
    if (!line.includes('\t')) return line;
    let column = 0;
    let expanded = '';
    for (const [index, part] of line.split('\t').entries()) {
      if (index > 0) {
        const fill = tabWidth - (column % tabWidth);
        expanded += ' '.repeat(fill);
        column += fill;
      }
      expanded += part;
      column += terminalCellWidth(part);
    }
    return expanded;
  }).join('\n');
}

/** The single choke point for text that did not originate in this program: a
 * paste, model output, tool output. A raw `\r` rewinds the row and overwrites
 * it, a tab moves the cursor by an amount the layout never measured, and an
 * escape sequence can retitle the window, write the clipboard (OSC 52), or
 * move the cursor out of the live region and corrupt every later frame.
 *
 * `keepSgr` is for rows this UI styled itself; untrusted text never keeps any
 * escape. Newlines survive unless `singleLine` folds them into spaces. */
export function sanitizeTerminalText(
  value: string, options: { keepSgr?: boolean; singleLine?: boolean; tabWidth?: number } = {},
): string {
  // Styled rows are checked on every frame, so the common clean case must not
  // pay for a rewrite just because it carries this UI's own color codes.
  const clean = options.keepSgr ? !UNSAFE_IN_STYLED_TEXT.test(value) : !NEEDS_SANITIZING.test(value);
  if (clean && !(options.singleLine && value.includes('\n'))) return value;
  let text = value.replace(/\r\n?/g, '\n');
  text = text.replace(ESCAPE_SEQUENCE, (sequence) => (
    options.keepSgr && (SGR_SEQUENCE.test(sequence) || OSC8_SEQUENCE.test(sequence)) ? sequence : ''));
  text = text.replace(CONTROL_CHARACTERS, (character) => (character === '\u001b' && options.keepSgr ? character : ''));
  text = expandTabs(text, options.tabWidth ?? TAB_WIDTH);
  return options.singleLine ? text.replace(/\n/g, ' ') : text;
}
