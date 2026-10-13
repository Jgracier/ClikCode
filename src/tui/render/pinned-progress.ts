/** The latest running step, kept above the status line.
 *
 * A running call used to live in the answer's scroll. The answer grew, the
 * step left the screen, and only the spinner stayed. Claude Code and Codex
 * keep that step at the bottom. One line until a click, then the live rows,
 * and a click again puts the one line back. Background work uses the same
 * band: the count while it is closed, the steps while it is open. */
import chalk from 'chalk';
import type { BackgroundWork } from '../../harness/protocol/background-agents.js';
import { backgroundTerminalsLabel, turnSummary } from '../../harness/protocol/turn-flow.js';
import { visibleSlice, terminalCellWidth } from './width.js';

export function backgroundStatusLine(work: BackgroundWork | undefined): string | undefined {
  if (!work) return undefined;
  const agents = work.agents ?? 0;
  const workflows = work.workflows ?? 0;
  const waiting = agents || workflows
    ? turnSummary({ ms: 0, ...(agents ? { pendingBackground: agents } : {}), ...(workflows ? { pendingWorkflows: workflows } : {}) })
    : undefined;
  const shells = backgroundTerminalsLabel(work.terminals);
  const line = [waiting, shells].filter(Boolean).join(' · ');
  return line || undefined;
}

/** Rows for the band. `lines` are the running calls, newest last. Closed
 * shows the newest one. Open shows the tail, up to `limit`, and the
 * background count under them when it is not already that line. */
export function pinnedProgressRows(input: {
  lines: readonly string[];
  open: boolean;
  background?: BackgroundWork;
  width: number;
  limit: number;
}): string[] {
  const content = input.lines.filter((line) => line.trim().length > 0);
  const background = backgroundStatusLine(input.background);
  if (!content.length && !background) return [];
  const width = Math.max(1, input.width);
  const fit = (line: string): string => visibleSlice(line, width);
  if (!input.open || input.limit <= 1) {
    const line = content.length ? content[content.length - 1]! : `  ${background}`;
    const hint = ' · click';
    const shown = terminalCellWidth(line) + hint.length <= width ? `${line}${chalk.dim(hint)}` : line;
    return [fit(shown)];
  }
  const room = Math.max(1, input.limit);
  const extra = background && !content.some((line) => line.includes(background)) ? [`  ${chalk.dim(background)}`] : [];
  const body = content.length ? content : [];
  return [...body, ...extra].slice(-room).map(fit);
}
