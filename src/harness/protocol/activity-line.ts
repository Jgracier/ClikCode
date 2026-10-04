/** One activity line as it appears on screen, and the phase label the
 * spinner shows beside it. */

import chalk from 'chalk';
import type { AiLocalHarnessDefinition } from '../definition.js';
import type { HarnessActivityEvent } from '../prompter.js';
import type { FileDiff } from '../../agent/line-diff.js';
import { type CommandPreview, activityOutcome, commandOutputPreview, DIFF_PREVIEW_LINES, diffPreview, diffTotals, outputPreview, previewLinesFor } from './activity-view.js';
import { activityResult, tensedLabel } from './turn-flow.js';
import { TOOL_CATEGORY_STYLE } from './tool-category-style.js';
import { claudeShaped, opencodeShaped, asRecord } from './json-lines.js';

export function renderActivityLine(event: HarnessActivityEvent): string[] {
  if (event.kind === 'thinking') return [`  ${chalk.cyan('thinking')} ${chalk.dim(event.label)}`];
  // The tool's own label, with nothing prepended to it. A status word in front
  // of every row ("done", "edit", "tool") restated what the row already said by
  // existing -- a finished tool is reported when it finishes -- and pushed the
  // call itself two words to the right on every line. Failure is the one state
  // a label cannot carry on its own, so that, and only that, reads differently.
  // Failure is the exception, and it is a suffix rather than a prefix: colour
  // alone would carry it only on a terminal that has colour, and a piped or
  // NO_COLOR transcript would read a failed call as a successful one.
  // A glyph for the kind of work, so the type reads without being spelled out
  // and a column of tool rows scans as a list rather than a wall.
  // Only where the category is actually known: an unclassified tool stays
  // bare, exactly as it was.
  const style = event.category ? TOOL_CATEGORY_STYLE[event.category] : undefined;
  const mark = style ? `${style.paint(style.glyph)} ` : '';
  const plainMark = style ? `${style.glyph} ` : '';
  const outcome = outcomeSuffix(event);
  // In the tense of its state -- `Reading a.ts` while it runs, `Read a.ts`
  // once done -- and then what it found (`42 lines`), before the outcome.
  // A failure keeps the call's own name: "Edited a.ts failed" says two things.
  const result = activityResult(event);
  const summary = `  ${event.kind === 'tool-error'
    ? `${chalk.red(`${plainMark}${event.label}`)} ${chalk.red('failed')}`
    : `${mark}${chalk.dim(`${tensedLabel(event.label, event.kind === 'tool-start')}${result ? ` · ${result}` : ''}`)}`}${outcome ? ` ${chalk.dim(outcome)}` : ''}`;
  if (!event.diff?.length) {
    // Budgeted by kind: a read's row already names the file, so repeating its
    // contents underneath says nothing the label did not.
    const budget = previewLinesFor(event.category);
    // A budget of zero means this kind of call says everything in its label.
    // Counting what is not shown ("… 3 more lines" under a filename) is
    // noise about noise -- strictly worse than the single clean row.
    if (budget === 0) return [summary];
    // A command whose whole output was kept: its first and last lines.
    const command = commandOutputPreview(event);
    if (command) return [summary, ...commandPreviewRows(command)];
    return [summary, ...outputPreviewRows(event, budget)];
  }
  return [summaryWithCounts(summary, event.diff), ...fileDiffRows(event.diff, DIFF_PREVIEW_LINES)];
}

function changeCounts(additions: number, removals: number): string {
  return [additions ? chalk.green(`+${additions}`) : '', removals ? chalk.red(`-${removals}`) : ''].filter(Boolean).join(' ');
}

/** The row's label, then what the change added and removed in all. */
function summaryWithCounts(summary: string, files: readonly FileDiff[]): string {
  const totals = diffTotals(files);
  const counts = changeCounts(totals.additions, totals.removals);
  return counts ? `${summary} ${counts}` : summary;
}

/** An edit as hunks: per file (named when there are several), each line with
 * its number where the numbers are real, removed red, added green, unchanged
 * context dim, `⋮` where unchanged lines between hunks are left out -- the
 * lines a reviewer needs, not two flat lists of what went and what came. */
export function fileDiffRows(files: readonly FileDiff[], budget: number): string[] {
  const preview = diffPreview(files, budget);
  const gutter = preview.gutter;
  const rows: string[] = [];
  for (const { file, lines } of preview.files) {
    if (files.length > 1) {
      const what = file.change === 'add' ? ' (new)' : file.change === 'delete' ? ' (deleted)' : '';
      rows.push(`    ${chalk.dim(`${file.path ?? 'file'}${what}`)} ${changeCounts(file.additions, file.removals)}`.trimEnd());
    }
    for (const line of lines) {
      const number = gutter ? `${line.line === undefined ? ''.padStart(gutter) : String(line.line).padStart(gutter)} ` : '';
      if (line.kind === 'gap') rows.push(`    ${chalk.dim(`${''.padStart(gutter)}${gutter ? ' ' : ''}\u22ee`)}`);
      else if (line.kind === 'removed') rows.push(`    ${chalk.dim(number)}${chalk.red(`- ${line.text}`)}`);
      else if (line.kind === 'added') rows.push(`    ${chalk.dim(number)}${chalk.green(`+ ${line.text}`)}`);
      else rows.push(`    ${chalk.dim(`${number}  ${line.text}`)}`);
    }
  }
  const notes = [
    ...(preview.hiddenLines > 0 ? [`${preview.hiddenLines} more line${preview.hiddenLines === 1 ? '' : 's'}`] : []),
    ...(preview.moreFiles > 0 ? [`${preview.moreFiles} more file${preview.moreFiles === 1 ? '' : 's'}`] : []),
  ];
  return notes.length ? [...rows, `    ${chalk.dim(`\u2026 ${notes.join(', ')}`)}`] : rows;
}

/** outputPreview's choice, painted for the terminal. */
export function outputPreviewRows(event: HarnessActivityEvent, budget: number): string[] {
  const { lines, hidden, fromEnd } = outputPreview(event, budget);
  if (!lines.length) return [];
  const note = hidden > 0 ? [`    ${chalk.dim(`\u2026 ${hidden} ${fromEnd ? 'earlier' : 'more'} line${hidden === 1 ? '' : 's'}`)}`] : [];
  const rows = lines.map((line) => `    ${chalk.dim(line)}`);
  return fromEnd ? [...note, ...rows] : [...rows, ...note];
}

/** commandOutputPreview's choice, painted: head, `… N lines hidden`, tail. */
export function commandPreviewRows(preview: CommandPreview): string[] {
  const row = (line: string): string => `    ${chalk.dim(line)}`;
  const note = preview.hidden > 0 ? [row(`\u2026 ${preview.hidden} line${preview.hidden === 1 ? '' : 's'} hidden`)] : [];
  return [...preview.head.map(row), ...note, ...preview.tail.map(row)];
}

/** `(exit 2 · 3.4s)`, `(12 tool uses · 30k tokens · 1m 5s)` after a
 * finished call (activityOutcome). */
function outcomeSuffix(event: HarnessActivityEvent): string | undefined {
  const outcome = activityOutcome(event);
  return outcome ? `(${outcome.parts.join(' · ')})` : undefined;
}

export function nativeActivityPhaseFromValue(harness: AiLocalHarnessDefinition, parsed: unknown): 'generating response' | undefined {
  const value = asRecord(parsed);
  if (!value) return undefined;
  const type = String(value.type ?? '');
  const itemType = String(asRecord(value.item)?.type ?? '');
  if (harness.parser === 'antigravity' && value.event === 'step_update') {
    const step = asRecord(value.step_update);
    if (step?.step_type === 'agent_response' && typeof step.text_delta === 'string') return 'generating response';
  }
  if (/assistant|agent_message/.test(itemType) && /started|delta|completed/.test(type)) return 'generating response';
  if (type === 'assistant') {
    // A Claude-shaped assistant record that only carries tool calls (or belongs
    // to a subagent) is not the reply being written.
    if (!claudeShaped(harness)) return 'generating response';
    if (typeof value.parent_tool_use_id === 'string' && value.parent_tool_use_id) return undefined;
    const content = asRecord(value.message)?.content;
    return !Array.isArray(content) || content.some((part) => asRecord(part)?.type === 'text') ? 'generating response' : undefined;
  }
  if (opencodeShaped(harness) && type === 'text') return 'generating response';
  return undefined;
}

