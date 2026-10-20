/** The waiting band: the spinner, and the rules and dimming that mark which
 * conversation lines are still live. */

import { terminalCellWidth, visibleSlice } from './width.js';
import { composerUsageLabel, usageLabelIsSpent, usageRemainingPercent } from './usage-words.js';
import { agentSpinnerGlyph, waitingSpinnerGlyph } from '../../harness/protocol/activity-view.js';
import chalk from 'chalk';
import { look } from '../../harness/protocol/tool-category-style.js';

export { composerUsageLabel, usageRemainingPercent };

/** Fill a terminal-width rule from the left and pin a short label to its
 * right edge. Both composer borders use this same layout: usage above and
 * the conversation title below. */
export function rightLabeledRule(width: number, label?: string): string {
  const suffix = label ? ` ${visibleSlice(label, Math.max(0, width - 4))}` : '';
  return `${'─'.repeat(Math.max(0, width - terminalCellWidth(suffix)))}${suffix}`;
}

/** One open call, drawn under the answer that is still streaming: the row it
 * settles into, the spinner in its glyph's place (a command's `$ make`, not
 * `running $ make`). A sub-agent says so. The row is repainted, not appended.
 * Its colour is the look's one running accent, the status line's. The
 * turn's clock stays on that line, so this row has none. */
export function runningChatLine(
  label: string, frame: number, kind: 'command' | 'agent' | 'tool',
  /** A still mark in the spinner's place, for a row that is written once and never redrawn. */
  still?: string,
): string {
  const spinner = look.paint.accent(still ?? (kind === 'agent' ? agentSpinnerGlyph(frame) : waitingSpinnerGlyph(frame)));
  // A title that already says it is one ("Agent worker 0") is not told again.
  const verb = kind === 'agent' && !/^agent\b/i.test(label) ? 'agent ' : '';
  return `  ${spinner}  ${verb}${label}`;
}

/** A live response must end on content, not its decorative separator. On a
 * short mobile viewport the last replaceable row may be the only row visible. */
export function liveConversationLines(lines: readonly string[], live: boolean): string[] {
  const result = [...lines];
  if (live) while (result[result.length - 1] === '') result.pop();
  return result;
}


/** A rule with its label painted and the dashes left as structure: the
 * dashes in the terminal's own foreground, and only the label at the right
 * edge painted, because it says something -- how much allowance is left,
 * which conversation this is. */
function paintLabeledRule(
  width: number, label: string | undefined, paint: (text: string) => string,
): string {
  // Unstyled, not dim: dim made the frame recede so far it read as absent.
  // Not chalk.white either, so a light-background theme gets its own.
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
