/** /search on screen: which rows show a mention, and the matches in them
 * drawn in inverse video. Pure: the prompter keeps the rows and the scroll
 * offset, this only reads and decorates rows. */

import { displayTokens } from './width.js';

/** Where /search is looking, as the prompter is told it. */
export interface MentionFocus {
  /** Index of the message in the conversation shown. */
  messageIndex: number;
  /** Which occurrence of the first word, counted from the message's start,
   * the mention is (0 is the first). */
  occurrence: number;
  /** Lower-cased words to highlight wherever they appear. */
  words: readonly string[];
  /** The line under the conversation while browsing; absent once done. */
  status?: string;
}

const INVERSE_ON = '\u001b[7m';
const INVERSE_OFF = '\u001b[27m';
const SGR = /^\u001b\[[0-9;]*m$/;

function visible(row: string): { text: string; tokens: string[] } {
  const tokens = displayTokens(row);
  let text = '';
  for (const token of tokens) if (token[0] !== '\u001b') text += token;
  return { text, tokens };
}

/** Ranges [start, end) of `words` in `text`, merged where they touch. */
function matchRanges(text: string, words: readonly string[]): Array<[number, number]> {
  const lower = text.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const word of words) {
    if (!word) continue;
    for (let at = lower.indexOf(word); at >= 0; at = lower.indexOf(word, at + word.length)) ranges.push([at, at + word.length]);
  }
  ranges.sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

/** `row` with every occurrence of `words` in inverse video, every other
 * cell and colour as it was. A colour change inside a match re-asserts the
 * inverse, since a reset there would switch it off. */
export function highlightWords(row: string, words: readonly string[]): string {
  if (!words.length || !row) return row;
  const { text, tokens } = visible(row);
  const ranges = matchRanges(text, words);
  if (!ranges.length) return row;
  let index = 0;
  let range = 0;
  let inside = false;
  let out = '';
  for (const token of tokens) {
    if (token[0] === '\u001b') {
      out += token;
      if (inside && SGR.test(token)) out += INVERSE_ON;
      continue;
    }
    while (range < ranges.length && index >= ranges[range]![1]) range += 1;
    const inMatch = range < ranges.length && index >= ranges[range]![0] && index < ranges[range]![1];
    if (inMatch && !inside) { out += INVERSE_ON; inside = true; }
    if (!inMatch && inside) { out += INVERSE_OFF; inside = false; }
    out += token;
    index += token.length;
  }
  if (inside) out += INVERSE_OFF;
  return out;
}

/** The row, among `rows`, holding the `occurrence`-th appearance of `word`
 * (counted across rows in order). The last row that has it when the
 * screen shows fewer than that (a long tool output is drawn shortened),
 * and undefined when no row does. */
export function rowOfOccurrence(rows: readonly string[], word: string, occurrence: number): number | undefined {
  let seen = 0;
  let last: number | undefined;
  for (const [index, row] of rows.entries()) {
    const lower = visible(row).text.toLowerCase();
    for (let at = lower.indexOf(word); at >= 0; at = lower.indexOf(word, at + word.length)) {
      if (seen === occurrence) return index;
      seen += 1;
      last = index;
    }
  }
  return last;
}
