/** One activity line as it appears on screen, and the phase label the
 * spinner shows beside it. */

import chalk from 'chalk';
import type { AiLocalHarnessDefinition } from '../definition.js';
import type { HarnessActivityEvent } from '../prompter.js';
import type { FileDiff } from '../../agent/line-diff.js';
import { previewLinesFor } from './activity-events.js';
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
  const summary = `  ${event.kind === 'tool-error'
    ? `${chalk.red(`${plainMark}${event.label}`)} ${chalk.red('failed')}`
    : `${mark}${chalk.dim(event.label)}`}${outcome ? ` ${chalk.dim(outcome)}` : ''}`;
  if (!event.diff?.length) {
    // Budgeted by kind: a read's row already names the file, so repeating its
    // contents underneath says nothing the label did not.
    const budget = previewLinesFor(event.category);
    // A budget of zero means this kind of call says everything in its label.
    // Counting what is not shown ("… 3 more lines" under a filename) is
    // noise about noise -- strictly worse than the single clean row.
    if (budget === 0) return [summary];
    return [summary, ...outputPreviewRows(event, budget)];
  }
  return [summaryWithCounts(summary, event.diff), ...fileDiffRows(event.diff, DIFF_PREVIEW_LINES)];
}

/** Diff lines an edit's row shows, across all its files. */
const DIFF_PREVIEW_LINES = 12;
/** Files of one change shown before the rest are counted. */
const DIFF_PREVIEW_FILES = 4;

function changeCounts(additions: number, removals: number): string {
  return [additions ? chalk.green(`+${additions}`) : '', removals ? chalk.red(`-${removals}`) : ''].filter(Boolean).join(' ');
}

/** The row's label, then what the change added and removed in all. */
function summaryWithCounts(summary: string, files: readonly FileDiff[]): string {
  const counts = changeCounts(files.reduce((sum, file) => sum + file.additions, 0), files.reduce((sum, file) => sum + file.removals, 0));
  return counts ? `${summary} ${counts}` : summary;
}

/** An edit as hunks: per file (named when there are several), each line with
 * its number where the numbers are real, removed red, added green, unchanged
 * context dim, `⋮` where unchanged lines between hunks are left out -- the
 * lines a reviewer needs, not two flat lists of what went and what came. */
export function fileDiffRows(files: readonly FileDiff[], budget: number): string[] {
  const shownFiles = files.slice(0, DIFF_PREVIEW_FILES);
  const numbers = shownFiles.flatMap((file) => file.lines.flatMap((line) => line.line === undefined ? [] : [line.line]));
  const gutter = numbers.length ? String(Math.max(...numbers)).length : 0;
  const rows: string[] = [];
  let left = budget;
  let hidden = 0;
  for (const file of shownFiles) {
    if (files.length > 1) {
      const what = file.change === 'add' ? ' (new)' : file.change === 'delete' ? ' (deleted)' : '';
      rows.push(`    ${chalk.dim(`${file.path ?? 'file'}${what}`)} ${changeCounts(file.additions, file.removals)}`.trimEnd());
    }
    const visible = file.lines.slice(0, Math.max(0, left));
    left -= visible.length;
    hidden += file.lines.length - visible.length + (file.omitted ?? 0);
    for (const line of visible) {
      const number = gutter ? `${line.line === undefined ? ''.padStart(gutter) : String(line.line).padStart(gutter)} ` : '';
      if (line.kind === 'gap') rows.push(`    ${chalk.dim(`${''.padStart(gutter)}${gutter ? ' ' : ''}\u22ee`)}`);
      else if (line.kind === 'removed') rows.push(`    ${chalk.dim(number)}${chalk.red(`- ${line.text}`)}`);
      else if (line.kind === 'added') rows.push(`    ${chalk.dim(number)}${chalk.green(`+ ${line.text}`)}`);
      else rows.push(`    ${chalk.dim(`${number}  ${line.text}`)}`);
    }
  }
  const moreFiles = files.length - shownFiles.length;
  const notes = [
    ...(hidden > 0 ? [`${hidden} more line${hidden === 1 ? '' : 's'}`] : []),
    ...(moreFiles > 0 ? [`${moreFiles} more file${moreFiles === 1 ? '' : 's'}`] : []),
  ];
  return notes.length ? [...rows, `    ${chalk.dim(`\u2026 ${notes.join(', ')}`)}`] : rows;
}

/** A tool's output under its row, at most `budget` lines. A command's result
 * is at its end, and so is all a producer kept of a long stream
 * (`outputTail`), so those show their LAST lines, the earlier ones counted
 * above them; anything else shows its first lines, the rest counted below.
 * Showing the first of a kept tail put a long command's middle on screen. */
export function outputPreviewRows(event: HarnessActivityEvent, budget: number): string[] {
  const output = event.output ?? [];
  if (!output.length || budget <= 0) return [];
  const fromEnd = event.outputTail === true || (event.category === 'run' && !event.outputOmitted);
  const visible = fromEnd ? output.slice(-budget) : output.slice(0, budget);
  const hidden = output.length - visible.length + (event.outputOmitted ?? 0);
  const note = hidden > 0 ? [`    ${chalk.dim(`\u2026 ${hidden} ${fromEnd ? 'earlier' : 'more'} line${hidden === 1 ? '' : 's'}`)}`] : [];
  const rows = visible.map((line) => `    ${chalk.dim(line)}`);
  return fromEnd ? [...note, ...rows] : [...rows, ...note];
}

/** `(exit 2, 3.4s)` after a finished call, from what the harness reported.
 * An exit of 0 and a sub-second run are what every call looks like, so only
 * the exceptions are spelled out. */
function outcomeSuffix(event: HarnessActivityEvent): string | undefined {
  if (event.kind !== 'tool-done' && event.kind !== 'tool-error') return undefined;
  const parts = [
    ...(event.exitCode !== undefined && event.exitCode !== 0 ? [`exit ${event.exitCode}`] : []),
    ...(event.durationMs !== undefined && event.durationMs >= 1000 ? [formatDuration(event.durationMs)] : []),
  ];
  return parts.length ? `(${parts.join(', ')})` : undefined;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`;
}

export function nativeActivityPhaseFromValue(harness: AiLocalHarnessDefinition, parsed: unknown): 'generating response' | undefined {
  const value = asRecord(parsed);
  if (!value) return undefined;
  const type = String(value.type ?? '');
  const itemType = String(asRecord(value.item)?.type ?? '');
  if (harness.command === 'antigravity' && value.event === 'step_update') {
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

