/** Where a tool call's rows sit in the transcript: the call at two columns,
 * and what it printed or changed at four, under it -- where a merged read's
 * calls and a sub-agent's step sit. Running and settled alike, so a call
 * finishing never moves its output sideways (it used to jump four columns
 * left as the command ended). */

import { visibleSlice } from './width.js';

/** The call's own row. `width` is the transcript's. */
export function callRow(line: string, width: number, paint: (text: string) => string = (text) => text): string {
  return `  ${paint(visibleSlice(line, Math.max(1, width - 2)))}`;
}

/** A row under the call: output, a diff line, a count of what is hidden.
 * Whatever indent the line came with is the call's business, not its. */
export function underCallRow(line: string, width: number): string {
  return `    ${visibleSlice(line.trim(), Math.max(1, width - 4))}`;
}
