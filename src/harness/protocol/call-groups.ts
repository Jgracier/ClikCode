/** A run of calls and thoughts as one group: which of them fold into the
 * group's one summary row, how that row reads, and what an item shows when it
 * is expanded. Pure and unstyled, so the terminal and the VS Code webview say
 * the same thing (the surfaces add colour and layout). */

import type { HarnessActivityEvent } from '../prompter.js';
import { activityOutcome } from './activity-view.js';
import { exploreSummary } from './turn-flow.js';

/** What is kept of a settled thought for expansion. `text` is absent on a turn
 * saved without it. */
export type GroupThought = { durationMs: number; heading?: string; text?: string };

/** One item of a group: a call, or a thought. */
export type GroupItem = { id: string; event?: HarnessActivityEvent; thought?: GroupThought };

/** Output lines an expanded call shows. */
export const DETAIL_OUTPUT_LINES = 20;

/** Items a group row folds away, as opposed to the ones that stay visible as
 * rows of their own: a failed or stopped call (errors must not hide), a
 * sub-agent, and a call waiting on an approval. */
export function standsAlone(item: Pick<GroupItem, 'event'>, waiting?: (event: HarnessActivityEvent) => boolean): boolean {
  const event = item.event;
  if (!event) return false;
  return Boolean(event.agent) || event.kind === 'tool-error' || Boolean(waiting?.(event) && event.kind === 'tool-start');
}

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

/** Words for each kind of call that is not a read or a search: past and present. */
const KINDS = {
  run: (n: number, now: boolean) => `${now ? 'running' : 'ran'} ${plural(n, 'command')}`,
  edit: (n: number, now: boolean) => `${now ? 'editing' : 'edited'} ${plural(n, 'file')}`,
  fetch: (n: number, now: boolean) => `${now ? 'fetching' : 'fetched'} ${plural(n, 'page')}`,
  other: (n: number, now: boolean) => `${now ? 'calling' : 'called'} ${plural(n, 'tool')}`,
} as const;

export type GroupSummary = {
  /** `Ran 4 commands, read 3 files, edited 1 file`: the calls that folded. */
  calls: string;
  thoughts: number;
  /** Calls that failed or were stopped: visible as rows of their own. */
  failed: number;
  stopped: number;
};

/** The counts of a group by kind, in the order each kind first appeared, in
 * the words the folded rows use (`read 3 files, searched 1 pattern` is
 * exploreSummary's, as in Claude Code). `running`: present tense. */
export function groupSummary(items: readonly GroupItem[], running: boolean, waiting?: (event: HarnessActivityEvent) => boolean): GroupSummary {
  const order: Array<'look' | keyof typeof KINDS> = [];
  const counts = { run: 0, edit: 0, fetch: 0, other: 0 };
  const looking: HarnessActivityEvent[] = [];
  let thoughts = 0;
  let failed = 0;
  let stopped = 0;
  const seen = (kind: (typeof order)[number]): void => { if (!order.includes(kind)) order.push(kind); };
  for (const item of items) {
    if (item.thought) { thoughts += 1; continue; }
    const event = item.event;
    if (!event) continue;
    if (standsAlone(item, waiting)) {
      if (event.kind === 'tool-error') { if (event.stopped) stopped += 1; else failed += 1; }
      continue;
    }
    if (event.category === 'read' || event.category === 'search') { seen('look'); looking.push(event); continue; }
    const kind = event.category === 'run' || event.category === 'edit' || event.category === 'fetch' ? event.category : 'other';
    seen(kind);
    counts[kind] += 1;
  }
  const parts = order.map((kind) => (kind === 'look'
    ? lowerFirst(exploreSummary(looking.map((event) => ({ ...event, kind: running ? 'tool-start' as const : 'tool-done' as const }))))
    : KINDS[kind](counts[kind], running)));
  const calls = parts.join(', ');
  return { calls: calls.charAt(0).toUpperCase() + calls.slice(1), thoughts, failed, stopped };
}

/** The summary row's words, plain: `Ran 4 commands · 2 thoughts · 1 failed`. */
export function groupSummaryText(summary: GroupSummary): string {
  return [
    summary.calls,
    ...(summary.thoughts ? [plural(summary.thoughts, 'thought')] : []),
    ...(summary.failed ? [`${summary.failed} failed`] : []),
    ...(summary.stopped ? [`${summary.stopped} stopped`] : []),
  ].filter(Boolean).join(' · ');
}

/** The call as the vendor made it, in full: a command is not cut at the
 * row's width. */
export function callCommand(event: HarnessActivityEvent): string {
  const input = event.call?.input;
  if (event.category === 'run' && input) {
    const command = input.command ?? input.cmd;
    const text = Array.isArray(command) ? command.map(String).join(' ') : typeof command === 'string' ? command : undefined;
    if (text?.trim()) return `$ ${text.trim()}`;
  }
  return event.label;
}

export type CallDetail = {
  command: string;
  /** `exit 2 · 3.4s`, where the call reported either. */
  outcome?: string;
  /** Lines of output, the last ones, as many as `DETAIL_OUTPUT_LINES`. */
  output: string[];
  /** Lines before `output` that are not shown. */
  earlier: number;
};

/** What an expanded call shows: its full command, how it ended, and the tail
 * of its output. A call recorded without output has the command only. */
export function callDetail(event: HarnessActivityEvent, lines = DETAIL_OUTPUT_LINES): CallDetail {
  const all = event.output ?? [];
  const shown = event.outputTail === true || event.category === 'run' ? all.slice(-lines) : all.slice(0, lines);
  const outcome = activityOutcome(event)?.parts.join(' · ');
  return {
    command: callCommand(event), ...(outcome ? { outcome } : {}), output: shown,
    earlier: all.length - shown.length + (event.outputOmitted ?? 0),
  };
}

/** Consecutive items with no prose between them (the same offset into the
 * answer) are one run. A snapshot rule for a surface that does not hold a
 * group open the way the terminal does. */
export function runsOf<T extends { offset?: number }>(items: readonly T[]): T[][] {
  const runs: T[][] = [];
  for (const item of items) {
    const run = runs[runs.length - 1];
    const tail = run?.[run.length - 1];
    if (run && tail && tail.offset !== undefined && tail.offset === item.offset) run.push(item);
    else runs.push([item]);
  }
  return runs;
}
