/** The waiting band: the spinner, and the rules and dimming that mark which
 * conversation lines are still live. */

import chalk from 'chalk';
import { terminalCellWidth, visibleSlice } from './width.js';
import { composerUsageLabel, usageLabelIsSpent, usageRemainingPercent } from './usage-words.js';
export { appendThought, liveWaitKind, waitingSpinnerGlyph, type Thought } from '../../harness/protocol/activity-view.js';
import { waitingSpinnerGlyph } from '../../harness/protocol/activity-view.js';
import { formatElapsed } from '../../harness/protocol/format.js';

export { composerUsageLabel, usageLabelIsSpent, usageRemainingPercent };

/** Fill a terminal-width rule from the left and pin a short label to its
 * right edge. Both composer borders use this same layout: usage above and
 * the conversation title below. */
export function rightLabeledRule(width: number, label?: string): string {
  const suffix = label ? ` ${visibleSlice(label, Math.max(0, width - 4))}` : '';
  return `${'─'.repeat(Math.max(0, width - terminalCellWidth(suffix)))}${suffix}`;
}

/** One open call, drawn under the answer that is still streaming. A command
 * or a sub-agent says so; any other tool is just its own label. The row is
 * repainted, not appended, and the status line is a different place. A call
 * running for a second or more shows for how long, the way a native CLI
 * times its own shell commands. */
export function runningChatLine(label: string, frame: number, kind: 'command' | 'agent' | 'tool' | 'swarm', elapsedMs = 0): string {
  const spinner = kind === 'command' ? chalk.yellow(waitingSpinnerGlyph(frame))
    : kind === 'agent' || kind === 'swarm' ? chalk.cyan(waitingSpinnerGlyph(frame))
      : chalk.dim(waitingSpinnerGlyph(frame));
  const verb = kind === 'command' ? 'running ' : kind === 'agent' ? 'agent ' : '';
  const timer = elapsedMs >= 1000 ? chalk.dim(` (${formatElapsed(elapsedMs)})`) : '';
  return `  ${spinner}  ${verb}${label}${timer}`;
}

/** A live response must end on content, not its decorative separator. On a
 * short mobile viewport the last replaceable row may be the only row visible. */
export function liveConversationLines(lines: readonly string[], live: boolean): string[] {
  const result = [...lines];
  if (live) while (result[result.length - 1] === '') result.pop();
  return result;
}


/** A rule with its label painted and the dashes left as structure.
 *
 * The rules themselves are always dim: they are furniture and should recede.
 * Only the label at the right edge carries colour, and only because it says
 * something -- how much allowance is left, which conversation this is. */
export function paintLabeledRule(
  width: number, label: string | undefined, paint: (text: string) => string,
): string {
  // The dashes are left unstyled, which is the terminal's own foreground --
  // the same white the composer's text is drawn in. Dim made the frame recede
  // so far it read as absent; at full weight the composer is a defined field
  // rather than a faint suggestion of one. Unstyled rather than chalk.white
  // so a light-background theme still gets its own foreground.
  const rule = rightLabeledRule(width, label);
  if (!label) return rule;
  const at = rule.lastIndexOf(label);
  if (at < 0) return rule;
  return `${rule.slice(0, at)}${paint(label)}`;
}

/** The chat's name, in the terminal's own foreground -- the same white as the
 * rule it sits on, the composer's text between the rules, and the usage
 * figure on the rule above. It used to be magenta, on the theory that the one
 * thing naming THIS conversation deserved a colour of its own; on screen it
 * read as the frame shouting in a second colour. Unstyled rather than an
 * explicit white, so a light-background theme still gets its own foreground.
 * The one colour the frame keeps is red for spent usage, because that one
 * asks for something to be done. */
const RULE_LABEL = (text: string): string => text;



/** Usage reads by state, but only one state is worth shouting about.
 *
 * Running out is red. Everything else is the terminal's own foreground, the
 * same white as the rule it sits on -- a figure that is fine needs no colour
 * to say so, and spending one on it only makes the one that matters quieter
 * by comparison. */
export function paintUsageRule(width: number, label?: string): string {
  return paintLabeledRule(width, label, usageLabelIsSpent(label) ? chalk.red : (text) => text);
}

/** The chat's own name, on the rule below the composer. */
export function paintTitleRule(width: number, label?: string): string {
  return paintLabeledRule(width, label, RULE_LABEL);
}
