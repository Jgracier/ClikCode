/** The waiting band: the spinner, and the rules and dimming that mark which
 * conversation lines are still live. */

import chalk from 'chalk';
import type { HarnessActivityEvent } from '../../harness/prompter.js';
import { isAgentToolName } from '../../harness/protocol/tools.js';
import { terminalCellWidth, visibleSlice } from './width.js';

/** Whether a still-open tool call is a command or a sub-agent. Reads and
 * edits stay in the waiting band; these two get a moving row in the chat.
 * A call already classified as a shell command stays a command even when
 * its text happens to start with an agent-shaped word. */
export function liveWaitKind(event: HarnessActivityEvent): 'command' | 'agent' | undefined {
  if (event.kind !== 'tool-start') return undefined;
  if (event.agent) return 'agent';
  if (event.category !== 'run' && isAgentToolName(event.label)) return 'agent';
  if (event.category === 'run') return 'command';
  return undefined;
}

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

/** One open call, drawn under the answer that is still streaming. A command
 * or a sub-agent says so; any other tool is just its own label. The row is
 * repainted, not appended, and the status line is a different place. */
export function runningChatLine(label: string, frame: number, kind: 'command' | 'agent' | 'tool'): string {
  const spinner = kind === 'command' ? chalk.yellow(waitingSpinnerGlyph(frame))
    : kind === 'agent' ? chalk.cyan(waitingSpinnerGlyph(frame))
      : chalk.dim(waitingSpinnerGlyph(frame));
  const verb = kind === 'command' ? 'running ' : kind === 'agent' ? 'agent ' : '';
  return `  ${spinner}  ${verb}${label}`;
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

/** The chat's name, in the terminal's own foreground -- the same white as the
 * rule it sits on, the composer's text between the rules, and the usage
 * figure on the rule above. It used to be magenta, on the theory that the one
 * thing naming THIS conversation deserved a colour of its own; on screen it
 * read as the frame shouting in a second colour. Unstyled rather than an
 * explicit white, so a light-background theme still gets its own foreground.
 * The one colour the frame keeps is red for spent usage, because that one
 * asks for something to be done. */
const RULE_LABEL = (text: string): string => text;

/** What the composer rule says once the allowance is gone.
 *
 * A window that refills says when, in the same words as everywhere else
 * (`Resets 5:34PM`, or with the weekday and date when that is not today).
 * A balance that does not refill has no time to give, so it says so.
 * A percentage at zero is not shown: the reset, or the credit line, is the
 * whole message. */
export function composerUsageLabel(label?: string, resetLabel?: string): string | undefined {
  if (resetLabel) return resetLabel;
  if (label && /credits exhausted|out of credits/i.test(label)) return 'Out Of Credits';
  return label;
}

function usageLabelIsSpent(label?: string): boolean {
  if (!label) return false;
  if (/^resets\b/i.test(label) || label === 'Out Of Credits') return true;
  const remaining = usageRemainingPercent(label);
  return /exhausted/i.test(label) || (remaining !== undefined && remaining <= 0);
}

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
