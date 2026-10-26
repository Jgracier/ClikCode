/** How a conversation row starts in the terminal's lists: the glyph column
 * in front of its title.
 *
 * A row's words -- title, state, last thing asked -- are conversationOption's
 * (session/options.ts); this is only the part a terminal paints. */

import chalk from 'chalk';
import { waitingSpinnerGlyph } from '../../harness/protocol/activity-view.js';
import type { PickerOption } from '../../harness/prompter.js';


/** The glyph column, three cells so every title starts in the same column: a
 * running turn's spinner (green), a blue dot for a
 * conversation waiting on the user, blank otherwise. `frame` animates the
 * spinner where the list can; a list that cannot passes 0. */
export function conversationLabel(option: Pick<PickerOption<string>, 'label' | 'activity'>, frame: number): string {
  if (option.activity === 'needs-you') return `${chalk.blue('●')}  ${option.label}`;
  if (option.activity) return `${workingSpinner(frame)} ${option.label}`;
  return `   ${option.label}`;
}

/** A running turn's spinner in the conversation list: the same two-cell
 * spinner as the waiting line, animated while it runs. */
function workingSpinner(frame: number): string {
  return chalk.green(waitingSpinnerGlyph(frame));
}
