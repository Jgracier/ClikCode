/** One activity line as it appears on screen, and the phase label the
 * spinner shows beside it. */

import chalk from 'chalk';
import type { AiLocalHarnessDefinition } from '../definition.js';
import type { HarnessActivityEvent } from '../prompter.js';
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
  const summary = `  ${event.kind === 'tool-error'
    ? `${chalk.red(`${plainMark}${event.label}`)} ${chalk.red('failed')}`
    : `${mark}${chalk.dim(event.label)}`}`;
  if (!event.diff) {
    const output = event.output ?? [];
    // Budgeted by kind: a read's row already names the file, so repeating its
    // contents underneath says nothing the label did not.
    const budget = previewLinesFor(event.category);
    // A budget of zero means this kind of call says everything in its label.
    // Counting what is not shown ("… 3 more lines" under a filename) is
    // noise about noise -- strictly worse than the single clean row.
    if (budget === 0) return [summary];
    const visible = output.slice(0, budget);
    const hidden = output.length - visible.length;
    return [summary, ...visible.map((line) => `    ${chalk.dim(line)}`),
      ...(hidden > 0 ? [`    ${chalk.dim(`\u2026 ${hidden} more line${hidden === 1 ? '' : 's'}`)}`] : [])];
  }
  // Budget both halves of an edit rather than filling it from the top: a large
  // deletion would otherwise consume the whole preview and hide every added
  // line, which is the half that says what the edit actually did.
  const { removed, added } = event.diff;
  const budget = previewLinesFor(event.category ?? 'edit');
  const removedShown = Math.min(removed.length, Math.max(
    Math.floor(budget / 2), budget - added.length,
  ));
  const addedShown = Math.min(added.length, budget - removedShown);
  const hidden = (removed.length - removedShown) + (added.length - addedShown);
  return [
    summary,
    ...removed.slice(0, removedShown).map((line) => `    ${chalk.red(`- ${line}`)}`),
    ...added.slice(0, addedShown).map((line) => `    ${chalk.green(`+ ${line}`)}`),
    ...(hidden > 0 ? [`    ${chalk.dim(`\u2026 ${hidden} more line${hidden === 1 ? '' : 's'}`)}`] : []),
  ];
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

function nativeActivityPhase(harness: AiLocalHarnessDefinition, lineText: string): 'generating response' | undefined {
  const candidate = lineText.trim();
  if (candidate[0] !== '{') return undefined;
  try {
    return nativeActivityPhaseFromValue(harness, JSON.parse(candidate));
  } catch {
    // fail-open-ok: non-JSON output is ordinary assistant text, not a structured result envelope.
    return undefined;
  }
}
