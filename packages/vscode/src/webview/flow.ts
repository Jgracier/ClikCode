/** How the panel lays out a turn as it unfolds: turn-flow.ts's shared rules
 * (the terminal's too) applied to the chat model, with the few choices only
 * a webview makes -- which colour class a status wears. Pure, and free of
 * anything that styles a terminal, so the page bundles it. */
import { answerWriting, backgroundTerminalsLabel, decisionRow, endsWithSummary, exploreRuns, explores, exploreSummary, liveTokenTarget, smoothTokens, tensedLabel, tokenMeterLabel, turnStatus, turnSummary, type Decision, type StatusTone } from '../../../../src/harness/protocol/turn-flow';
import { shimmerCycleMs, SPIN_MS } from '../../../../src/harness/protocol/timings';
import { TOOL_CATEGORY } from '../../../../src/harness/protocol/tool-category';
import type { ToolCategory } from '../../../../src/harness/prompter';
import type { FileDiff } from '../protocol';
import type { Activity, LiveTurn, TurnTrace } from '../model';
import { formatElapsed } from '../../../../src/harness/protocol/format';
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
  if (reconnecting) return { label: 'Reconnecting…', tone: 'thinking', toneClass: 'tone-yellow' };
  // Stopping, it says so, whatever call is still open (the terminal's rule).
  const stopping = Boolean(live?.stopping);
  const status = turnStatus({
    phase: stopping ? 'stopping' : live ? live.phase ?? live.waitingLabel : 'starting',
    ...(live?.toolPhase && !stopping ? { toolPhase: live.toolPhase } : {}),
    ...(live?.thought && !stopping ? { thought: live.thought.text } : {}),
    asking,
    writing: answerWriting({ writingAt: live?.writingAt, callAt: live?.callAt }),
  });
  const open = live?.openTools[live.openTools.length - 1]?.[1];
  const toneClass = status.tone === 'asking' ? 'tone-permission'
    : status.tone !== 'tool' ? 'tone-cyan'
      : open?.agent ? 'tone-cyan' : open?.category ? `tone-${TOOL_CATEGORY[open.category].colour}` : 'tone-plain';
  return { ...status, label: `${titleCase(status.label.replace(/(…|\.\.\.)$/, '').trim() || 'working')}…`, toneClass };
}

/** How many of a running turn's earliest groups fold under "N earlier
 * steps": all but the newest `visible`, and never one still running. Five
 * agents started in parallel and two calls after them hid the first agents
 * -- and their spinners -- while they ran, where the terminal keeps every
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

/** A finished run of calls folded to one line: each run of looking-around
 * calls as Claude Code says it ("Read 3 files, searched 2 patterns"), the
 * rest by kind ("ran 2 commands"). */
export function foldedSummary(activities: readonly Activity[]): string {
  const segments: Array<{ explore: boolean; rows: Activity[] }> = [];
  for (const group of exploreRuns(activities)) {
    const last = segments[segments.length - 1];
    if (!group.explore && last && !last.explore) last.rows.push(...group.rows);
    else segments.push({ explore: group.explore, rows: [...group.rows] });
  }
  const text = segments.map((segment, index) => {
    if (!segment.explore) return runSummary(segment.rows);
    const said = exploreSummary(segment.rows);
    return index ? said.charAt(0).toLowerCase() + said.slice(1) : said;
  }).join(' · ');
  return titleCase(text);
}

/** The working line's background-terminals indicator (`2 background
 * terminals running`) while any run, else nothing. It is not part of the
 * turn's closing line. */
export function workingIndicator(live: Pick<LiveTurn, 'background'> | undefined): string | undefined {
  return backgroundTerminalsLabel(live?.background?.terminals);
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
    if (!trace.stopped && !background && !workflows && !endsWithSummary(ms, trace.activities.length)) return undefined;
    // What it spent, in the terminal's own words (formatTurnUsage, brief).
    const usage = formatTurnUsage(trace.usage, { brief: true });
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
