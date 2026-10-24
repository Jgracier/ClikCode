/** Where a tool call's rows sit in the transcript: the call at two columns,
 * and what it printed or changed at four, under it -- where a merged read's
 * calls and a sub-agent's step sit. Running and settled alike, so a call
 * finishing never moves its output sideways (it used to jump four columns
 * left as the command ended). */

import { thoughtLine } from '../../harness/protocol/tool-category-style.js';
import { thoughtRow as thoughtText } from '../../harness/protocol/turn-flow.js';
import { visibleSlice } from './width.js';
import { wrapWords } from './wrap.js';

/** The call's own row. `width` is the transcript's. */
export function callRow(line: string, width: number, paint: (text: string) => string = (text) => text): string {
  return `  ${paint(visibleSlice(line, Math.max(1, width - 2)))}`;
}

/** A note (`activity()`): something ClikCode says in the turn, an error most of
 * all. It is prose, not a call's label, so it keeps all it says: wrapped at two
 * columns like the call, never clipped with `…` (a refusal's first clause is
 * its least useful part). Its colour is carried onto every row. */
export function noteRows(line: string, width: number): string[] {
  const open = /^(?:\u001b\[[0-9;]*m)+/.exec(line)?.[0] ?? '';
  return wrapWords(line, Math.max(1, width - 2)).map((row, index) => `  ${open && index > 0 ? open : ''}${row}${open ? '\u001b[0m' : ''}`);
}

/** A row under the call: output, a diff line, a count of what is hidden.
 * Whatever indent the line came with is the call's business, not its. */
export function underCallRow(line: string, width: number): string {
  return `    ${visibleSlice(line.trim(), Math.max(1, width - 4))}`;
}

/** A thought once it is over, in the turn where it was had: how long it
 * went on, as Claude Code and VS Code say it. The live row above the
 * waiting line showed its words while it was had. */
export function thoughtRow(ms: number, heading?: string): string {
  return thoughtLine(thoughtText({ durationMs: ms, ...(heading ? { heading } : {}) }));
}
