/** How the panel lays out a turn as it unfolds: turn-flow.ts's shared rules
 * (the terminal's too) applied to the chat model, with the few choices only
 * a webview makes -- which colour class a status wears. Pure, and free of
 * anything that styles a terminal, so the page bundles it. */
import { exploreRuns, exploreSummary, tensedLabel, turnStatus, type StatusTone } from '../../../../src/harness/protocol/turn-flow';
import { TOOL_CATEGORY } from '../../../../src/harness/protocol/tool-category';
import type { ToolCategory } from '../../../../src/harness/prompter';
import type { Activity, LiveTurn } from '../model';
import { WRITING_MS } from '../../../../src/harness/protocol/timings';
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
export function workingStatus(live: LiveTurn | undefined, asking: boolean, now: number): WorkingStatus {
  const status = turnStatus({
    phase: live ? live.phase ?? live.waitingLabel : 'starting',
    ...(live?.toolPhase ? { toolPhase: live.toolPhase } : {}),
    ...(live?.thought ? { thought: live.thought.text } : {}),
    asking,
    writing: live?.writingAt !== undefined && now - live.writingAt < WRITING_MS,
  });
  const open = live?.openTools[live.openTools.length - 1]?.[1];
  const toneClass = status.tone === 'asking' ? 'tone-permission'
    : status.tone !== 'tool' ? 'tone-cyan'
      : open?.agent ? 'tone-cyan' : open?.category ? `tone-${TOOL_CATEGORY[open.category].colour}` : 'tone-plain';
  return { ...status, label: `${titleCase(status.label.replace(/(…|\.\.\.)$/, '').trim() || 'working')}…`, toneClass };
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
