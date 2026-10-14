/** Builds the rows the conversation is made of: messages, activity, tool and grouped-call rows, saved and running turns. */
import chalk from 'chalk';
import { readTurnActivities } from '../../../turn/turn-activities.js';
import { readTurnMarks } from '../../../turn/turn-marks.js';
import type { SettlingTool } from '../../../turn/transcript.js';
import type { HarnessActivityEvent, ToolCategory } from '../../../harness/prompter.js';
import type { TranscriptMessage, HarnessSession } from '../../../session/model.js';
import { ActivityEntry, collapseToolRuns, settleDecisionEntry, upsertActivityEvent } from '../../render/activity-log.js';
import { toolUses, liveWaitKind, waitingSpinnerGlyph } from '../../../harness/protocol/activity-view.js';
import { outputPreviewRows, renderActivityLine } from '../../../harness/protocol/activity-line.js';
import { tensedLabel } from '../../../harness/protocol/turn-flow.js';
import { CallGrouping, LIVE_SHOWN_CALLS, liveItemLine, type CallRun, type GroupRow } from '../../render/call-groups.js';
import { groupSummary, groupSummaryText, standsAlone } from '../../../harness/protocol/call-groups.js';
import { tagRow } from '../../render/row-tags.js';
import { TOOL_CATEGORY_STYLE, TOOL_ROW_TEXT } from '../../../harness/protocol/tool-category-style.js';
import { terminalCellWidth } from '../../render/width.js';
import { STEER_WORDS, steerTranscriptRows } from '../../render/steer-rows.js';
import { messageRows as cachedMessageRows } from '../../render/message-blocks.js';
import { callRow, underCallRow } from '../../render/tool-rows.js';
import { callDecision, markThought, savedTurnRanks, turnMarkLines } from '../../render/turn-mark-rows.js';
import { runningChatLine } from '../../render/waiting.js';
import type { TerminalHarnessPrompter } from '../../prompter.js';
import { LIVE_OUTPUT_LINES } from '../state.js';


/** Message and activity rows at the conversation's width. */
export function createRowBuilders(p: TerminalHarnessPrompter, conversationInner: number) {
  const userMarker = chalk.bold('›');
  // No marker in front of a tool row. The bullet was there to carry the
  // category colour, and it cost a glyph on every line of every call --
  // including each line of captured output, which made a transcript of
  // real work read as a column of dots. The label already says `Bash(...)`
  // and carries the colour itself; the spinner in the waiting band is
  // where the category still shows while a call runs.
  // The call, and under it what it printed (tool-rows.ts): running and
  // settled at the same indent.
  const underCall = (line: string): string => underCallRow(line, conversationInner);
  // One blank row above a call, none below it: what follows -- the next
  // call, the next paragraph -- opens with its own, so the gap under a
  // call's output is one row, as the gap above it is. Activity between
  // messages (standaloneActivity) closes its own.
  const activityRows = (lines: readonly string[], category?: ToolCategory): string[] => (lines.length
    ? ['', ...lines.map((line, index) => (index > 0 ? underCall(line)
      : callRow(line, conversationInner)))]
    : []);
  const messageRows = (content: string, marker: string): readonly string[] => cachedMessageRows(content, marker, conversationInner);
  /** A user-side message: what the user wrote. */
  const userRows = (content: string): readonly string[] => messageRows(content, userMarker);
  /** Activity that belongs between two messages rather than inside a turn.
   * Retired once, by identity rather than by text -- two rows that say the
   * same thing are still two rows -- and an entry that arrives after its
   * anchor has been passed is appended where it lands, which is the only
   * thing an append-only transcript can do with it. */
  const standaloneActivity = (anchor: number): string[] => {
    const rows: string[] = [];
    // Folded first: six reads in a row become one row, and the answer they
    // were serving stays on screen.
    if (p.collapsedActivity?.source !== p.activityEntries) {
      p.collapsedActivity = { source: p.activityEntries, entries: collapseToolRuns(p.activityEntries) };
    }
    for (const entry of p.collapsedActivity.entries) {
      if (entry.anchor !== anchor || entry.responseOffset !== undefined) continue;
      const id = entry.sequence;
      if (!p.emitted.claimActivity(id)) continue;
      rows.push(...activityRows(entry.lines, entry.event?.category), '');
    }
    return rows;
  };
  return { conversationInner, userMarker, underCall, activityRows, messageRows, userRows, standaloneActivity };
}
export type RowBuilders = ReturnType<typeof createRowBuilders>;

/** A call as a settling row: its own, or merged into a run of reads. */
export function createToolRows(p: TerminalHarnessPrompter, builders: RowBuilders) {
  const { underCall, activityRows, conversationInner } = builders;
  /** The in-flight turn's tools and steering messages, as rows that settle.
   * A call that is still running is `done: false`: the same slot in the
   * live region, spinner instead of the settled glyph, so finishing it
   * changes the glyph rather than moving the row. At the end of the turn
   * a tool that never reported completion settles anyway. */
  const refused = (entry: ActivityEntry): boolean => entry.decision !== undefined && entry.decision.kind !== 'approved';
  const toolRow = (entry: ActivityEntry, ended: boolean): SettlingTool => {
    const id = entry.event?.id ?? `activity#${entry.sequence ?? entry.responseOffset}`;
    // A refused call is over, whatever the vendor has yet to say about it.
    const running = !ended && entry.event?.kind === 'tool-start' && !refused(entry);
    const order = { ...(entry.sequence === undefined ? {} : { seq: entry.sequence }), ...(entry.event?.agent ? { agent: true } : {}) };
    if (!running) {
      return {
        id, done: true, responseOffset: entry.responseOffset, ...order,
        lines: activityRows(entry.lines, entry.event?.category),
      };
    }
    const kind = liveWaitKind(entry.event!) ?? 'tool';
    const frame = p.reducedMotion ? 0 : p.waitingFrame;
    const row = runningChatLine(
      tensedLabel(entry.event?.label ?? '', true), frame, kind, entry.event?.category,
    ).trim();
    // What it has printed so far, newest last, under the spinner -- a long
    // build or test run is visibly working instead of a bare timer.
    const live = entry.event ? outputPreviewRows({ ...entry.event, outputTail: true }, LIVE_OUTPUT_LINES).map(underCall) : [];
    // A sub-agent that has to be retired while it still runs: the same text
    // with a static glyph and `running`; when it settles one completion row
    // is appended (`✓ <label> (N tool uses · ...)`), and its live children
    // are named by a `↳ <label>` line (transcript.ts).
    const agentRows = entry.event?.agent ? (() => {
      const label = tensedLabel(entry.event.label, true);
      const settled = renderActivityLine({ ...entry.event, kind: 'tool-done' })[0]?.trim() ?? label;
      return {
        released: ['', `  ${runningChatLine(label, 0, kind, entry.event.category).trim()} ${chalk.dim('· running')}`],
        completed: ['', `  ${chalk.green('✓')} ${settled}`],
        childHeader: [`    ${chalk.dim(`↳ ${entry.event.label}`)}`],
      };
    })() : {};
    return {
      id, done: false, responseOffset: entry.responseOffset, ...order, ...agentRows,
      lines: ['', `  ${row}`, ...live],
    };
  };
  /** The waiting-for-approval calls: they stay visible, never folded. */
  const waitingOnApproval = (event: HarnessActivityEvent): boolean => event.id !== undefined
    && (p.pendingApproval?.callId === event.id || p.approvalQueue.some((queued) => queued.callId === event.id));
  const tagged = (lines: readonly string[], group: string, item: string): string[] =>
    lines.map((line) => (line.trim() ? tagRow(line, { kind: 'g', group, item }) : line));
  /** A group's summary row: counts by kind in the tool-row blue, what failed
   * in red, and `· tap` where the width has room. */
  const summaryLine = (items: readonly (ActivityEntry & GroupRow)[], running: boolean, plainOnly: boolean): string => {
    const summary = groupSummary(items.map((item) => ({ id: item.key, event: item.event, ...(item.thought ? { thought: item.thought } : {}) })), running, waitingOnApproval);
    const blue = [summary.calls, ...(summary.thoughts ? [`${summary.thoughts} thought${summary.thoughts === 1 ? '' : 's'}`] : [])].filter(Boolean).join(' · ');
    if (plainOnly) return blue;
    const style = TOOL_CATEGORY_STYLE.run;
    const marks = [
      ...(summary.failed ? [chalk.red(`${summary.failed} failed`)] : []),
      ...(summary.stopped ? [chalk.yellow(`${summary.stopped} stopped`)] : []),
    ];
    const text = `${TOOL_ROW_TEXT(blue)}${marks.map((mark) => ` ${chalk.dim('·')} ${mark}`).join('')}`;
    const hint = ' · tap';
    const fits = terminalCellWidth(groupSummaryText(summary)) + hint.length + 4 <= conversationInner;
    return `${style.paint(style.glyph)} ${text}${fits ? chalk.dim(hint) : ''}`;
  };
  /** A run of calls and thoughts as one row (call-groups.ts). Running, the
   * summary spins in the row's place with the newest items under it; settled,
   * it is the one summary row. The items stay reachable from it (a tap, or
   * Ctrl+O, opens them in the panel). */
  const groupRow = (run: CallRun<ActivityEntry & GroupRow>, folded: ReadonlyArray<ActivityEntry & GroupRow>, ended: boolean, id: string): SettlingTool => {
    const first = folded[0]!;
    const running = !ended && folded.some((member) => member.event.kind === 'tool-start');
    const order = { ...(first.sequence === undefined ? {} : { seq: first.sequence }) };
    if (!run.done) {
      const under = folded.slice(-LIVE_SHOWN_CALLS).map((member) => underCall(liveItemLine(member, ended)));
      const head = running
        ? `  ${runningChatLine(summaryLine(run.items, true, true), p.reducedMotion ? 0 : p.waitingFrame, 'tool', first.event.category).trim()}`
        : `  ${summaryLine(run.items, false, false)}`;
      return { id, done: false, responseOffset: first.responseOffset, ...order, lines: tagged(['', head, ...under], groupIdOf(run), '') };
    }
    return { id, done: true, responseOffset: first.responseOffset, ...order, lines: tagged(activityRows([summaryLine(run.items, false, false)]), groupIdOf(run), '') };
  };
  const groupIdOf = (run: CallRun<ActivityEntry & GroupRow>): string => `${run.items[0]!.anchor}:${run.key}`;
  /** One run's rows: a group row when two or more of its items fold, else
   * each item as the row it always was -- a lone call is its own summary. */
  const runRows = (run: CallRun<ActivityEntry & GroupRow>, ended: boolean): SettlingTool[] => {
    const alones = run.items.filter((item) => standsAlone(item, waitingOnApproval));
    const folded = run.items.filter((item) => !standsAlone(item, waitingOnApproval));
    const id = groupIdOf(run);
    p.callGroups.set({ id, items: run.items.map((item) => ({ id: item.key, entry: item })), running: !run.done && run.items.some((item) => item.event.kind === 'tool-start') });
    const single = (item: ActivityEntry & GroupRow, held: boolean): SettlingTool => {
      const row = toolRow(item, ended);
      return { ...row, ...(held && row.done ? { done: false } : {}), lines: tagged(row.lines, id, item.key) };
    };
    if (folded.length < 2) return run.items.map((item) => single(item, !run.done && !alones.includes(item)));
    return [groupRow(run, folded, ended, `grp:${run.key}`), ...alones.map((item) => single(item, false))];
  };
  /** The turn's rows, runs of calls and thoughts grouped. A finished call
   * waits in the live region while its run is open: the next may join it. */
  const groupedRows = (entries: readonly ActivityEntry[], ended: boolean, grouping: CallGrouping): SettlingTool[] => {
    // A row of its own that never joins a run: a note (lines and no event,
    // from activity()), a plan or notice, or a call the user refused, whose
    // row says so.
    const alone = (entry: ActivityEntry): boolean => !entry.event || refused(entry) || (entry.event.kind === 'thinking' && !entry.thought);
    const rows = entries.flatMap((entry) => (entry.event && !alone(entry) ? [{ ...entry, event: entry.event, key: entry.event.id ?? `activity#${entry.sequence ?? entry.responseOffset}` }] : []));
    const runs = grouping.group(rows, ended, ended ? Number.POSITIVE_INFINITY : p.liveResponse.length);
    return [...runs.flatMap((run) => runRows(run, ended)), ...entries.filter(alone).map((entry) => toolRow(entry, ended))];
  };
  return { toolRow, groupedRows };
}

/** The seam state a turn's steer rows depend on, set once the transcript's
 * resume point is known (before any of the rows below are asked for). */
export type TurnSeam = { materializedPendingTurn: boolean };

/** A saved message's calls, and the running turn's calls, as rows. */
export function createTurnTools(
  p: TerminalHarnessPrompter, builders: RowBuilders, toolRows: ReturnType<typeof createToolRows>, pending: HarnessSession['pendingTurn'], seam: TurnSeam,
) {
  const { messageRows, userMarker } = builders;
  const { groupedRows } = toolRows;
  /** The running turn's own tool calls: anchored at the message count when
   * it began, which is at or before the index its answer lands at. */
  const turnEntries = (anchor: number): ActivityEntry[] => p.activityEntries.filter((entry) =>
    entry.anchor === anchor && entry.responseOffset !== undefined && !entry.event?.parentId);
  /** A saved message's calls, as rows: folded into entries by the same
   * upsert the running turn's events go through, and grouped and drawn by
   * the same functions, so a reopened turn looks as it did live. */
  const savedTools = (message: TranscriptMessage, index: number): SettlingTool[] => {
    const calls = readTurnActivities(message.activities, message.content.length).filter((activity) => !activity.event.parentId);
    const marks = readTurnMarks(message.marks);
    if (!calls.length && !marks.length) return [];
    // Calls and the turn's durable marks (a thought, the plan, a notice, an
    // approval's outcome) are drawn in one order (turn-mark-rows.ts), and a
    // mark is an entry like the settled thought is live, so it breaks a run
    // of reads the way it did while the turn ran.
    const ranks = savedTurnRanks(calls, marks);
    const at = (offset: number): number => Math.min(offset, message.content.length);
    let entries: ActivityEntry[] = [];
    for (const [position, activity] of calls.entries()) {
      entries = upsertActivityEvent(entries, index, at(activity.responseOffset), activity.event, ranks.activities[position]!, 0);
    }
    for (const [position, mark] of marks.entries()) {
      const on = callDecision(mark);
      if (on) {
        entries = settleDecisionEntry(entries, { anchor: index, responseOffset: at(mark.responseOffset), sequence: ranks.marks[position]!, ...on });
        continue;
      }
      const lines = turnMarkLines(mark);
      if (!lines.length) continue;
      entries.push({
        anchor: index, responseOffset: at(mark.responseOffset), sequence: ranks.marks[position]!,
        event: { kind: 'thinking', label: mark.id, id: mark.id }, lines,
        ...(mark.kind === 'thought' ? { thought: markThought(mark) } : {}),
      });
    }
    return groupedRows(entries, true, new CallGrouping());
  };
  const turnTools = (ended: boolean): SettlingTool[] => {
    const tools: SettlingTool[] = groupedRows(turnEntries(p.activityAnchor)
      // An anchor is reused: the next turn's assistant occupies the same
      // index when the previous one was never persisted. The turn that
      // produced an entry is what decides whether it belongs to this one.
      .filter((entry) => (entry.sequence ?? 0) > p.emitted.turnSequenceFloor), ended, p.callGrouping);
    // A running agent's live calls, one row each, nested under it. They are
    // never retired (the turn's end drops them with their parent) and never
    // gate another row; where they sit is child-rows.ts's rule.
    if (!ended) {
      const open = turnEntries(p.activityAnchor).filter((entry) => entry.event?.kind === 'tool-start' && entry.event.id
        && (entry.sequence ?? 0) > p.emitted.turnSequenceFloor);
      const frame = p.reducedMotion ? 0 : p.waitingFrame;
      for (const child of p.liveChildren.rows(open.map((entry) => ({ id: entry.event!.id!, offset: entry.responseOffset, seq: entry.sequence })))) {
        const uses = child.newest ? open.find((entry) => entry.event!.id === child.parentId)?.event?.childTools : undefined;
        tools.push({
          id: child.id, done: false, nested: true, parent: child.parentId, responseOffset: child.offset, seq: child.seq,
          lines: [`    ${chalk.cyan(waitingSpinnerGlyph(frame))} ${chalk.dim(`${child.label}${uses ? ` · ${toolUses(uses)}` : ''}`)}`],
        });
      }
    }
    // One row on each side, matching every other message: a steer is a
    // message the user wrote mid-answer.
    const steerRows = (text: string): string[] => [
      '', '', ...messageRows(text, userMarker), `  ${chalk.dim(`↳ ${STEER_WORDS.steered}`)}`, '',
    ];
    const steers = steerTranscriptRows({
      durable: pending?.steers ?? [], live: p.waitingSubmissions,
      materializedPendingTurn: seam.materializedPendingTurn, retiredThisSession: p.emitted.retiredTexts(), render: steerRows,
    });
    for (const row of steers) p.turnSteers.set(row.id, row);
    // A steer drawn earlier is still this turn's row once its sources are
    // gone (the turn has ended: the saved list is all that is left of it).
    // It is owed under the id it was first drawn with -- once, whichever
    // copy arrives -- so it is drawn from what was kept, never again from
    // the saved user message that replaces it.
    tools.push(...(seam.materializedPendingTurn ? steers : [...p.turnSteers.values()]));
    return tools;
  };
  return { savedTools, turnTools };
}

