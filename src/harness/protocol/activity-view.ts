/** What a tool row shows, decided once for every client. The terminal paints
 * these choices with chalk (activity-line.ts, prompter.ts); the VS Code
 * webview paints the same choices as HTML. Nothing here styles anything, so
 * the webview can bundle it. */

import type { FileDiff, DiffLine } from '../../agent/line-diff.js';
import type { HarnessActivityEvent, ToolCategory } from '../prompter.js';

/** How much of a tool's work a transcript row shows. Enough to recognise the
 * edit or command at a glance without the trail crowding out the answer. */
export const ACTIVITY_PREVIEW_LINES = 8;

/** Preview budget per kind of work, because one number cannot fit all of it.
 *
 * Eight lines is right for a diff -- the edit IS the lines -- and far too
 * generous for everything else. A read's row already names the file, so its
 * output repeats what the label said; a command's first lines are the ones
 * that matter and the rest is scroll. At 8 for everything, three tool calls
 * filled half a phone screen and the answer they were serving fell off the
 * bottom. */
export const CATEGORY_PREVIEW_LINES: Readonly<Record<ToolCategory, number>> = {
  edit: ACTIVITY_PREVIEW_LINES,
  run: 3,
  search: 3,
  fetch: 2,
  read: 0,
};

/** Lines a settled tool row may show, given what kind of work it was. */
export function previewLinesFor(category?: ToolCategory): number {
  return category ? CATEGORY_PREVIEW_LINES[category] : ACTIVITY_PREVIEW_LINES;
}

/** Lines of a running call's output shown under it. */
export const LIVE_OUTPUT_LINES = 3;
/** Diff lines an edit's row shows, across all its files. */
export const DIFF_PREVIEW_LINES = 12;
/** Files of one change shown before the rest are counted. */
export const DIFF_PREVIEW_FILES = 4;

/** Whether `next` is another frame of the call `prior` records. One provider
 * may publish pending/running/progress frames for the same tool: by id, a
 * call's row is found whatever state it is in (detail that arrives after it
 * finished, a final diff, belongs in that row); without an id only a still
 * open row with the same label can be the same call. */
export function sameCall(prior: HarnessActivityEvent, next: HarnessActivityEvent): boolean {
  if (next.id) return prior.id === next.id;
  return prior.kind === 'tool-start' && prior.label === next.label;
}

/** A later frame of a call, merged into what the row already knew. */
export function mergeActivity(prior: HarnessActivityEvent, next: HarnessActivityEvent): HarnessActivityEvent {
  return {
    ...next,
    // A finished call stays finished: a later frame without a status adds
    // its detail but cannot reopen it.
    ...(next.kind === 'tool-start' && prior.kind !== 'tool-start' ? { kind: prior.kind } : {}),
    ...(next.label === 'tool' || !next.label ? { label: prior.label } : {}),
    // A completion frame routinely carries neither the name nor the input
    // the category was derived from. The row keeps what its start knew.
    ...(next.category ? {} : prior.category ? { category: prior.category } : {}),
    ...(next.agent ? {} : prior.agent ? { agent: prior.agent } : {}),
    ...(next.diff ? {} : prior.diff ? { diff: prior.diff } : {}),
    ...(next.durationMs !== undefined || prior.durationMs === undefined ? {} : { durationMs: prior.durationMs }),
    ...(next.exitCode !== undefined || prior.exitCode === undefined ? {} : { exitCode: prior.exitCode }),
    // Likewise its output: a completion that carries none (most do not)
    // used to erase every line the running tool had streamed.
    ...(next.output?.length || !prior.output?.length ? {} : {
      output: prior.output,
      ...(prior.outputOmitted ? { outputOmitted: prior.outputOmitted } : {}),
      ...(prior.outputTail ? { outputTail: true } : {}),
    }),
  };
}

export type OutputPreview = { lines: string[]; hidden: number; fromEnd: boolean };

/** A tool's output under its row, at most `budget` lines. A command's result
 * is at its end, and so is all a producer kept of a long stream
 * (`outputTail`), so those show their LAST lines, the earlier ones counted
 * above them; anything else shows its first lines, the rest counted below.
 * Showing the first of a kept tail put a long command's middle on screen. */
export function outputPreview(event: Pick<HarnessActivityEvent, 'output' | 'outputOmitted' | 'outputTail' | 'category'>, budget: number): OutputPreview {
  const output = event.output ?? [];
  const fromEnd = event.outputTail === true || (event.category === 'run' && !event.outputOmitted);
  if (!output.length || budget <= 0) return { lines: [], hidden: 0, fromEnd };
  const lines = fromEnd ? output.slice(-budget) : output.slice(0, budget);
  return { lines, hidden: output.length - lines.length + (event.outputOmitted ?? 0), fromEnd };
}

export type DiffPreview = {
  files: Array<{ file: FileDiff; lines: DiffLine[] }>;
  /** Width of the line-number gutter; 0 when no line carries a number. */
  gutter: number;
  hiddenLines: number;
  moreFiles: number;
};

/** The part of a change a row shows: at most `budget` lines across the
 * first DIFF_PREVIEW_FILES files, with what was left out counted. */
export function diffPreview(files: readonly FileDiff[], budget: number): DiffPreview {
  const shown = files.slice(0, DIFF_PREVIEW_FILES);
  const numbers = shown.flatMap((file) => file.lines.flatMap((line) => line.line === undefined ? [] : [line.line]));
  let left = budget;
  let hiddenLines = 0;
  const kept = shown.map((file) => {
    const lines = file.lines.slice(0, Math.max(0, left));
    left -= lines.length;
    hiddenLines += file.lines.length - lines.length + (file.omitted ?? 0);
    return { file, lines };
  });
  return { files: kept, gutter: numbers.length ? String(Math.max(...numbers)).length : 0, hiddenLines, moreFiles: files.length - shown.length };
}

/** What an edit added and removed in all. */
export function diffTotals(files: readonly FileDiff[]): { additions: number; removals: number } {
  return {
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    removals: files.reduce((sum, file) => sum + file.removals, 0),
  };
}

export type Thought = { id?: string; text: string };

const THOUGHT_LIMIT = 2000;

/** A reasoning event added to the thought on screen.
 *
 * Transports differ: some send each reasoning item whole, some its running
 * total, some every 1-3 token fragment. Replacing the row with each event
 * made the last kind a flicker of single words. So within one reasoning item
 * (same id, or no ids at all) text that extends the thought -- or repeats
 * it -- replaces it, and anything else is appended; a new item id starts
 * afresh. Fragments arrive trimmed by some transports, so one without its own
 * spacing is joined with a space -- a word split mid-way reads better than
 * words run together. */
export function appendThought(prior: Thought | undefined, label: string, id?: string): Thought | undefined {
  const fragment = label.replace(/\s+/g, ' ');
  const trimmed = fragment.trim();
  if (!trimmed || trimmed.toLowerCase() === 'thinking') return prior;
  const withId = (text: string): Thought => ({ ...(id === undefined ? {} : { id }), text: text.length > THOUGHT_LIMIT ? text.slice(-THOUGHT_LIMIT) : text });
  if (!prior || prior.id !== id) return withId(trimmed);
  if (trimmed.startsWith(prior.text)) return withId(trimmed);
  const joined = /^[\s.,;:!?)\]'"]/.test(fragment) || /\s$/.test(prior.text) ? `${prior.text}${fragment}` : `${prior.text} ${fragment}`;
  return withId(joined.replace(/\s+/g, ' ').trim());
}

/** What a sub-agent is doing now, for its parent's row: the label of its
 * latest call or thought, cleared when that call finishes. */
export function childActivity(current: string | undefined, event: HarnessActivityEvent): string | undefined {
  if (event.kind === 'tool-start' || event.kind === 'thinking') return event.label;
  if (event.kind === 'tool-done' || event.kind === 'tool-error') return undefined;
  return current;
}
