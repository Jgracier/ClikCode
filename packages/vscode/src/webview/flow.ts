/** How the panel lays out a turn as it unfolds: turn-flow.ts's shared rules
 * (the terminal's too) applied to the chat model, with the few choices only
 * a webview makes -- which colour class a status wears. Pure, and free of
 * anything that styles a terminal, so the page bundles it. */
import { describeCommands } from '../../../../src/harness/protocol/background-agents';
import { answerWriting, backgroundTerminalsLabel, decisionRow, endsWithSummary, exploreRuns, explores, exploreSummary, liveTokenTarget, smoothTokens, tensedLabel, tokenMeterLabel, turnStatus, turnSummary, type Decision, type StatusTone } from '../../../../src/harness/protocol/turn-flow';
import { shimmerCycleMs, SPIN_MS } from '../../../../src/harness/protocol/timings';
import { TOOL_CATEGORY } from '../../../../src/harness/protocol/tool-category';
import type { HarnessActivityEvent, ToolCategory } from '../../../../src/harness/prompter';
import { agentTask, callArgs, callCommand, groupSummary, groupSummaryText, standsAlone, type GroupItem } from '../../../../src/harness/protocol/call-groups';
import type { FileDiff } from '../protocol';
import type { Activity, LiveTurn, ThoughtEntry, TurnTrace } from '../model';
import { formatElapsed } from '../../../../src/harness/protocol/format';
import { changedFileCount, endLineUsageShown } from '../../../../src/harness/protocol/lean';
import { formatTurnUsage } from '../../../../src/tui/render/usage-line';
import type { TurnUsage } from '../../../../src/harness/protocol/turn-usage';
import { titleCase } from './format';

export interface WorkingStatus {
  /** As shown: `Reading app.ts…`, `Waiting for you…`. */
  label: string;
  tone: StatusTone;
  /** The colour class: thinking blue, the running call's own colour, the
   * permission colour while asking. */
  toneClass: string;
}

/** The working line, by turn-flow's rule: waiting on the user, else the open
 * call's verb, else the reasoning's heading, else "writing" while answer
 * text arrives, else "thinking". */
export function workingStatus(live: LiveTurn | undefined, asking: boolean, now: number, reconnecting = false): WorkingStatus {
  // The bridge is coming back: not working, not waiting on the user.
  if (reconnecting) return { label: 'Reconnecting…', tone: 'thinking', toneClass: 'tone-stopped' };
  // Stopping, it says so, whatever call is still open (the terminal's rule).
  const stopping = Boolean(live?.stopping);
  const status = turnStatus({
    phase: stopping ? 'stopping' : live ? live.phase ?? live.waitingLabel : 'starting',
    ...(live?.toolPhase && !stopping ? { toolPhase: live.toolPhase } : {}),
    ...(live?.thought && !stopping ? { thought: live.thought.text } : {}),
    asking,
    writing: answerWriting({ writingAt: live?.writingAt, callAt: live?.callAt }),
  });
  // One running accent for every tone, tool and harness (look.ts).
  const toneClass = 'tone-accent';
  return { ...status, label: `${titleCase(status.label.replace(/(…|\.\.\.)$/, '').trim() || 'working')}…`, toneClass };
}

/** How many of a running turn's earliest groups fold under "N earlier
 * steps": all but the newest `visible`, and never one still running. Five
 * agents started in parallel and two calls after them hid the first agents
 * -- and their running rows -- while they ran, where the terminal keeps every
 * running row in view. */
export function foldedGroupCount(groups: ReadonlyArray<{ rows: ReadonlyArray<Pick<Activity, 'kind'>> }>, visible: number): number {
  const firstRunning = groups.findIndex((group) => group.rows.some((row) => row.kind === 'tool-start'));
  const excess = Math.max(0, groups.length - visible);
  return firstRunning < 0 ? excess : Math.min(excess, firstRunning);
}

/** What a run of calls did, in the terminal's folded words per kind; one
 * call alone is its own label, in its tense. */
export function runSummary(activities: readonly Activity[]): string {
  if (activities.length === 1) return tensedLabel(activities[0]!.label, activities[0]!.kind === 'tool-start');
  const counts = new Map<string, number>();
  for (const activity of activities) {
    const kind = activity.agent ? 'agent' : activity.category ?? 'other';
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts].map(([kind, count]) => (kind === 'agent' ? `ran ${count} agent${count === 1 ? '' : 's'}`
    : kind === 'other' ? `${count} step${count === 1 ? '' : 's'}`
      : TOOL_CATEGORY[kind as ToolCategory].folded(count))).join(' · ');
}

/** One item of a run of calls and thoughts (harness/protocol/call-groups.ts). */
export type RunItem = { activity: Activity; thought?: undefined } | { thought: ThoughtEntry; activity?: undefined };

export const runItemKey = (item: RunItem): string => (item.activity ? item.activity.key : `h${item.thought.seq}`);

const groupItemOf = (item: RunItem): GroupItem => (item.activity
  ? { id: item.activity.key, event: item.activity as unknown as HarnessActivityEvent }
  : { id: `h${item.thought.seq}`, thought: { durationMs: item.thought.ms, ...(item.thought.heading ? { heading: item.thought.heading } : {}), ...(item.thought.text ? { text: item.thought.text } : {}) } });

/** A failed or stopped call, a sub-agent: a call a folded run keeps in view as a row of its own. */
export const runItemStandsAlone = (item: RunItem): boolean => Boolean(item.activity) && standsAlone(groupItemOf(item));

/** A run of calls and thoughts in one line, the terminal's words: `Ran 4
 * commands, read 3 files · 2 thoughts · 1 failed`. */
export function runGroupSummary(items: readonly RunItem[]): string {
  return groupSummaryText(groupSummary(items.map(groupItemOf), false));
}

/** A finished run of calls folded to one line: each run of looking-around
 * calls as Claude Code says it ("Read 3 files, searched 2 patterns"), the
 * rest by kind ("ran 2 commands"). One call alone is its own label. */
export function foldedSummary(activities: readonly Activity[]): string {
  if (activities.length === 1) return titleCase(runSummary(activities));
  return runGroupSummary(activities.map((activity) => ({ activity })));
}

/** Background work other than agents, for the fixed work section. Agent rows
 * have their own labels and spinners there. */
export function workingIndicator(live: Pick<LiveTurn, 'background'> | undefined): string | undefined {
  const work = live?.background;
  const workflows = work?.workflows ?? 0;
  return [workflows ? turnSummary({ ms: 0, pendingWorkflows: workflows }) : undefined,
    // Named by pid when the worker could read them (age, cpu, silence): what is waited on, not a bare count.
    describeCommands(work?.commands ?? []) ?? backgroundTerminalsLabel(work?.terminals)].filter(Boolean).join(' · ') || undefined;
}

/** The line a finished turn ends on, the same live and on reopen, or nothing.
 * A trace with no clock of its own (a turn saved before the worker kept how
 * long it took) invents none: a stopped one says only "Stopped", and the rest
 * say only what they changed, never a made-up "Worked for 1s". */
export function traceSummaryLine(
  trace: Pick<TurnTrace, 'startedAt' | 'endedAt' | 'stopped' | 'activities'> & Partial<Pick<TurnTrace, 'usage' | 'pendingBackground' | 'pendingWorkflows'>>,
  diffs: ReadonlyArray<readonly FileDiff[]>,
): string | undefined {
  if (trace.endedAt > 0) {
    const ms = trace.endedAt - trace.startedAt;
    const background = trace.pendingBackground ?? 0;
    const workflows = trace.pendingWorkflows ?? 0;
    if (!trace.stopped && !background && !workflows && !endsWithSummary(ms, changedFileCount(diffs))) return undefined;
    // What it spent, in the terminal's own words (formatTurnUsage, brief).
    const usage = endLineUsageShown(trace.usage) ? formatTurnUsage(trace.usage, { brief: true }) : '';
    return turnSummary({
      ms, diffs, ...(trace.stopped ? { stopped: true } : {}), ...(usage ? { usage } : {}), ...(background ? { pendingBackground: background } : {}),
      ...(workflows ? { pendingWorkflows: workflows } : {}),
    });
  }
  if (trace.stopped) return 'Stopped';
  // No clock: only what was changed.
  const said = turnSummary({ ms: 0, diffs });
  const at = said.indexOf(' · ');
  return at < 0 ? undefined : said.slice(at + 3);
}

/** A run's groups as rows, with keys that survive the merge points. A call
 * that only looks around (a read, a search) is an "Explored" row from its
 * first frame, so a second one joining it changes that row, never swaps one
 * component for another (which destroyed the DOM: selection, open state,
 * scroll). Everything else is a call row under its own key. */
export function runGroupView<T extends Activity>(groups: ReadonlyArray<{ rows: T[]; explore: boolean }>): Array<{ key: string; kind: 'explored' | 'call'; rows: T[] }> {
  return groups.map((group) => (group.explore || explores(group.rows[0]!)
    ? { key: `e${group.rows[0]!.key}`, kind: 'explored' as const, rows: group.rows }
    : { key: group.rows[0]!.key, kind: 'call' as const, rows: group.rows }));
}

/** The log's follow-the-bottom state after a scroll event. Scrolling UP is
 * the reader leaving the bottom -- however small, a streaming delta must not
 * pull them back -- unless the log merely got shorter (a turn folding),
 * which the browser reports as a smaller scrollTop too. Coming back within
 * `threshold` px of the bottom follows again. */
export function followsBottom(
  previous: { follow: boolean; top: number; height: number },
  now: { top: number; height: number; client: number },
  threshold = 80,
): { follow: boolean; top: number; height: number } {
  const leftBottom = now.top < previous.top && now.height >= previous.height;
  const distance = now.height - now.top - now.client;
  const follow = leftBottom ? false : distance < threshold ? true : previous.follow;
  return { follow, top: now.top, height: now.height };
}

/** What a decision says on the call's own row, where the call's label already
 * names what was decided: `✓ approved`, `✗ denied`, `↳ told: use pnpm`. */
export function decisionBadge(decision: Decision): { text: string; tone: 'ok' | 'no' | 'told' } {
  const row = 'label' in decision ? decisionRow({ ...decision, label: '' }) : decisionRow(decision);
  return { text: row.text.trim(), tone: row.tone };
}

/** The label shimmer's timing as inline style: one sweep takes as long as
 * the terminal's (a cell per spinner step, shimmerCycleMs), and `steps` makes
 * the highlight jump a cell at a time rather than glide. */
export function shimmerStyle(label: string): string {
  const cycle = shimmerCycleMs(label.length);
  return `--shimmer-cycle: ${cycle}ms; --shimmer-steps: ${Math.max(1, Math.round(cycle / SPIN_MS))}`;
}

/** The status line's token count after one more step: toward what the turn
 * has produced (the larger of the vendor's reported output and what was written / 4),
 * never down within a turn (smoothTokens). `label` is `↓ 1.2k tokens`, and
 * absent while there is nothing to count. */
export function liveMeter(state: { shown: number; usage?: Pick<TurnUsage, 'output'> | undefined; responseChars: number; thoughtChars?: number }): { tokens: number; label?: string } {
  const tokens = smoothTokens(state.shown, liveTokenTarget({
    ...(state.usage ? { usage: state.usage } : {}), responseChars: state.responseChars, ...(state.thoughtChars ? { thoughtChars: state.thoughtChars } : {}),
  }));
  const label = tokenMeterLabel(tokens);
  return { tokens, ...(label ? { label } : {}) };
}

/** The working line's trailing detail: the turn's clock, then the meter --
 * `1m 2s · ↓ 1.2k tokens`, as the terminal words it. */
export function workingDetail(elapsedMs: number, meter: string | undefined): string {
  return `${formatElapsed(elapsedMs)}${meter ? ` · ${meter}` : ''}`;
}

/** What an open call shows besides its output, diff and children: a command in
 * full (the label is clipped), what a tool was asked, a sub-agent's task. The
 * terminal's words (call-groups.ts), so each is there for any call that
 * carries it, and nothing is made up for one that does not. */
export function activityMore(activity: Activity): { task?: string; command?: string; args: string[] } {
  const event = activity as unknown as HarnessActivityEvent;
  const command = !activity.agent && activity.category === 'run' ? callCommand(event) : undefined;
  const task = activity.agent ? agentTask(event) : undefined;
  return { ...(task ? { task } : {}), ...(command && command !== activity.label ? { command } : {}), args: callArgs(event) };
}
