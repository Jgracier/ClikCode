/** The waiting band: the spinner, and the rules and dimming that mark which
 * conversation lines are still live. */

import chalk from 'chalk';
import { terminalCellWidth, visibleSlice } from './width.js';

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

/** Fill a terminal-width rule from the left and pin a short label to its
 * right edge. Both composer borders use this same layout: usage above and
 * the conversation title below. */
export function rightLabeledRule(width: number, label?: string): string {
  const suffix = label ? ` ${visibleSlice(label, Math.max(0, width - 4))}` : '';
  return `${'─'.repeat(Math.max(0, width - terminalCellWidth(suffix)))}${suffix}`;
}

/** A live response must end on content, not its decorative separator. On a
 * short mobile viewport the last replaceable row may be the only row visible. */
export function liveConversationLines(lines: readonly string[], live: boolean): string[] {
  const result = [...lines];
  if (live) while (result[result.length - 1] === '') result.pop();
  return result;
}

/** How much of an allowance is left, read out of the label the harness gave.
 * Both forms appear: "42% left" and the legacy "58% used". */
export function usageRemainingPercent(label?: string): number | undefined {
  if (!label) return undefined;
  const left = [...label.matchAll(/(\d+(?:\.\d+)?)%\s*left/gi)].map((m) => Number(m[1]));
  if (left.length) return Math.min(...left);
  const used = [...label.matchAll(/(\d+(?:\.\d+)?)%\s*used/gi)].map((m) => Number(m[1]));
  return used.length ? 100 - Math.max(...used) : undefined;
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

/** The chat's name is the one thing on the frame that identifies THIS
 * conversation rather than describing its state, so it keeps a colour of its
 * own. Magenta rather than cyan, which belongs to ClikCode's own chrome, and
 * rather than yellow, which reads muddy on a dark terminal and fights
 * whatever theme the user chose. */
const RULE_LABEL = (text: string): string => chalk.magenta(text);

/** Usage reads by state, but only one state is worth shouting about.
 *
 * Running out is red. Everything else is the terminal's own foreground, the
 * same white as the rule it sits on -- a figure that is fine needs no colour
 * to say so, and spending one on it only makes the one that matters quieter
 * by comparison. */
export function paintUsageRule(width: number, label?: string): string {
  const remaining = usageRemainingPercent(label);
  const spent = label !== undefined
    && (/exhausted/i.test(label) || (remaining !== undefined && remaining <= 0));
  return paintLabeledRule(width, label, spent ? chalk.red : (text) => text);
}

/** The chat's own name, on the rule below the composer. */
export function paintTitleRule(width: number, label?: string): string {
  return paintLabeledRule(width, label, RULE_LABEL);
}
