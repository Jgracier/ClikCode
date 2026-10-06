/** How a conversation row starts in the terminal's lists: the glyph column
 * in front of its title, and its running sub-agents as an inner list.
 *
 * A row's words -- title, state, last thing asked -- are conversationOption's
 * (session/options.ts); this is only the part a terminal paints. */

import chalk from 'chalk';
import { waitingSpinnerGlyph } from '../render/waiting.js';
import { formatElapsed } from '../../harness/protocol/format.js';
import { turnStalled } from '../../harness/protocol/turn-pace.js';
import type { PickerOption } from '../../harness/prompter.js';
import type { HarnessSession } from '../../session/model.js';

type RowActivity = NonNullable<PickerOption<string>['activity']>;

/** The glyph column, three cells so every title starts in the same column: a
 * running turn's spinner (green, yellow once stalled), a blue dot for a
 * conversation waiting on the user, blank otherwise. `frame` animates the
 * spinner where the list can; a list that cannot passes 0. */
export function conversationLabel(option: Pick<PickerOption<string>, 'label' | 'activity'>, frame: number): string {
  if (option.activity === 'needs-you') return `${chalk.blue('●')}  ${option.label}`;
  if (option.activity) return `${workingSpinner(frame, option.activity)} ${option.label}`;
  return `   ${option.label}`;
}

/** A running turn's spinner in the conversation list: the same two-cell
 * spinner as the waiting line, yellow once the turn has stalled. */
export function workingSpinner(frame: number, activity: Exclude<RowActivity, 'needs-you'>): string {
  return (activity === 'stalled' ? chalk.yellow : chalk.green)(waitingSpinnerGlyph(frame));
}

/** A conversation's running agents as rows of their own: `● Explore
 * Read(src/a.ts) · 5m`, the dot yellow once the agent has stalled. Each
 * opens the conversation it belongs to: that is where its work is shown. */
export function subagentOptions(
  pending: NonNullable<HarnessSession['pendingTurn']>, conversationValue: string, now: number,
): PickerOption<string>[] {
  return (pending.subagents ?? []).map((agent) => {
    const stalled = turnStalled(now - Date.parse(agent.stepAt ?? agent.startedAt));
    return {
      label: `${(stalled ? chalk.yellow : chalk.green)('●')} ${agent.label}`,
      detail: `${agent.step ?? 'starting'} · ${formatElapsed(now - Date.parse(agent.startedAt))}`,
      value: conversationValue,
    };
  });
}
