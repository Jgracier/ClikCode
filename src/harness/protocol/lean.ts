/** The thresholds that decide what a surface says and what it keeps quiet,
 * shared by the terminal and the editor so the two never drift: a line that
 * repeats what is on screen, or a figure nobody asked for, is left out, and
 * what it leaves out stays in /usage, /status and the saved turn. Pure. */
import type { FileDiff } from '../../agent/line-diff.js';
import type { TurnUsage } from './turn-usage.js';

/** A turn this long ends on its summary line even if it changed nothing. */
export const END_LINE_MIN_MS = 10_000;
/** Tokens and cost join the end line only for a turn this large... */
export const END_USAGE_MIN_TOKENS = 20_000;
/** ...or this expensive (also when the editor shows a chat's cost inline). */
export const COST_INLINE_MIN_USD = 0.05;
/** A call's `(exit N · duration)` shows a duration only from this long. */
export const CALL_DURATION_MIN_MS = 5_000;
/** The usage figure sits in the footer when this much or less is left. */
export const USAGE_LOW_PERCENT = 25;
/** Under a failed call: the last this many lines of its output. */
export const FAILED_OUTPUT_LINES = 3;
/** One `Edited path +N −M` line per file, this many files, then `+K more files`. */
export const EDIT_FILES_SHOWN = 4;

/** Whether a turn ends on the `Worked for` line: it took a while or changed files. */
export function endLineShown(ms: number, filesChanged: number): boolean {
  return filesChanged > 0 || ms >= END_LINE_MIN_MS;
}

/** Whether the end line carries what the turn spent. */
export function endLineUsageShown(usage?: Pick<TurnUsage, 'input' | 'output' | 'costUsd'>): boolean {
  if (!usage) return false;
  return (usage.input ?? 0) + (usage.output ?? 0) >= END_USAGE_MIN_TOKENS || (usage.costUsd ?? 0) >= COST_INLINE_MIN_USD;
}

/** Whether a cost is worth a figure of its own. */
export function costShownInline(costUsd: number | undefined): boolean {
  return costUsd !== undefined && Number.isFinite(costUsd) && costUsd >= COST_INLINE_MIN_USD;
}

/** The `(exit N · duration)` a call row carries, or nothing: an exit code
 * only when it is not 0, a duration only from 5 s. */
export function callOutcome(exitCode: number | undefined, ms: number | undefined): string | undefined {
  const parts = [
    ...(exitCode !== undefined && exitCode !== 0 ? [`exit ${exitCode}`] : []),
    ...(ms !== undefined && ms >= CALL_DURATION_MIN_MS ? [durationWords(ms)] : []),
  ];
  return parts.length ? `(${parts.join(' · ')})` : undefined;
}

function durationWords(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Whether the usage figure belongs in the footer: only when it is low or spent. */
export function usageIsLow(remainingPercent: number | undefined, spent: boolean): boolean {
  return spent || (remainingPercent !== undefined && remainingPercent <= USAGE_LOW_PERCENT);
}

/** The last lines of a failed call's output: that is the error. */
export function failedOutputTail(output: string | undefined): string[] {
  const lines = (output ?? '').replace(/\r\n/g, '\n').split('\n').map((line) => line.trimEnd());
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.slice(-FAILED_OUTPUT_LINES);
}

/** How many distinct files a turn's diffs touch. */
export function changedFileCount(diffs: ReadonlyArray<readonly FileDiff[]>): number {
  const paths = new Set<string>();
  let anonymous = 0;
  for (const diff of diffs) for (const file of diff) paths.add(file.path ?? `#${anonymous++}`);
  return paths.size;
}
