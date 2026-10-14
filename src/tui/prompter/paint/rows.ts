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
import { groupSummary, groupSummaryText, isExpandable, standsAlone } from '../../../harness/protocol/call-groups.js';
import { tagRow } from '../../render/row-tags.js';
import { capOpenRows, openGroupRows, soloRows } from '../../render/group-rows.js';
import { look, toolGlyph } from '../../../harness/protocol/tool-category-style.js';
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
  /** The calls a sub-agent made, for its expansion: the live turn's, or the saved turn's. */
  const liveChildrenOf = (id: string): ActivityEntry[] => p.childEntries.filter((child) => child.event?.parentId === id);
  let childrenOf = liveChildrenOf;
  const toolRow = (entry: ActivityEntry, ended: boolean): SettlingTool => {
    const id = entry.event?.id ?? `activity#${entry.sequence ?? entry.responseOffset}`;
    // A call that opens on its own: a tap or Ctrl+O shows more of it, in place.
    const expandable = isExpandable(entry.event) || Boolean(entry.decision?.detail);
    const solo = `call:${id}`;
    const state = p.groupExpansion.get(solo);
    const open = (lines: readonly string[], row: ActivityEntry = entry): string[] => (expandable
      ? soloRows({ id: solo, lines, entry: row, children: entry.event?.agent ? childrenOf(entry.event.id ?? '') : [], state, width: conversationInner })
      : [...lines]);
    if (expandable) p.callGroups.set({ id: solo, items: [{ id: solo, entry }], running: entry.event?.kind === 'tool-start' });
    // A refused call is over, whatever the vendor has yet to say about it.
    const running = !ended && entry.event?.kind === 'tool-start' && !refused(entry);
    const order = { ...(entry.sequence === undefined ? {} : { seq: entry.sequence }), ...(entry.event?.agent ? { agent: true } : {}) };
    if (!running) {
      return {
        id, done: true, responseOffset: entry.responseOffset, ...order,
        lines: open(activityRows(entry.lines, entry.event?.category)),
      };
    }
    const kind = liveWaitKind(entry.event!) ?? 'tool';
    const frame = p.reducedMotion ? 0 : p.waitingFrame;
    const row = runningChatLine(
      tensedLabel(entry.event?.label ?? '', true), frame, kind,
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
        released: open(['', `  ${runningChatLine(label, 0, kind).trim()} ${chalk.dim('· running')}`]),
        completed: open(['', `  ${look.paint.success('✓')} ${settled}`]),
        childHeader: [`    ${chalk.dim(`↳ ${entry.event.label}`)}`],
      };
    })() : {};
    return {
      id, done: false, responseOffset: entry.responseOffset, ...order, ...agentRows,
      lines: open(['', `  ${row}`, ...live]),
    };
  };
  /** The waiting-for-approval calls: they stay visible, never folded. */
  const waitingOnApproval = (event: HarnessActivityEvent): boolean => event.id !== undefined
    && (p.pendingApproval?.callId === event.id || p.approvalQueue.some((queued) => queued.callId === event.id));
  const tagged = (lines: readonly string[], group: string, item: string): string[] =>
    lines.map((line) => (line.trim() ? tagRow(line, { group, item }) : line));
  /** A group's summary row: counts by kind in the tool-row blue, what failed
   * in red, and `· tap` where the width has room. */
  const summaryLine = (items: readonly (ActivityEntry & GroupRow)[], running: boolean, plainOnly: boolean, open = false): string => {
    const summary = groupSummary(items.map((item) => ({ id: item.key, event: item.event, ...(item.thought ? { thought: item.thought } : {}) })), running, waitingOnApproval);
    const blue = [summary.calls, ...(summary.thoughts ? [`${summary.thoughts} thought${summary.thoughts === 1 ? '' : 's'}`] : [])].filter(Boolean).join(' · ');
    if (plainOnly) return blue;
    const marks = [
      ...(summary.failed ? [look.paint.failed(`${summary.failed} failed`)] : []),
      ...(summary.stopped ? [look.paint.stopped(`${summary.stopped} stopped`)] : []),
    ];
    const text = `${look.paint.summary(blue)}${marks.map((mark) => ` ${chalk.dim('·')} ${mark}`).join('')}`;
    const hint = open ? ' · tap to collapse' : ' · tap';
    const fits = terminalCellWidth(groupSummaryText(summary)) + hint.length + 4 <= conversationInner;
    return `${toolGlyph()} ${text}${fits ? chalk.dim(hint) : ''}`;
  };
  /** A run of calls and thoughts as one row (call-groups.ts). Running, the
   * summary spins in the row's place with the newest items under it; settled,
   * it is the one summary row. Opened by a tap or Ctrl+O (p.groupExpansion),
   * it grows where it is: the items listed right under the header, each
   * opened to its detail -- the same rows live and reopened. */
  const groupRow = (run: CallRun<ActivityEntry & GroupRow>, folded: ReadonlyArray<ActivityEntry & GroupRow>, ended: boolean, id: string, gid: string): SettlingTool => {
    const first = folded[0]!;
    const running = !ended && folded.some((member) => member.event.kind === 'tool-start');
    const order = { ...(first.sequence === undefined ? {} : { seq: first.sequence }) };
    const state = p.groupExpansion.get(gid);
    const items = (live: boolean) => folded.map((member, index) => ({ id: itemIdOf(member, index), line: live ? liveItemLine(member, ended) : (member.lines[0] ?? ''), entry: member }));
    if (!run.done) {
      const head = running
        ? `  ${runningChatLine(summaryLine(run.items, true, true), p.reducedMotion ? 0 : p.waitingFrame, 'tool').trim()}`
        : `  ${summaryLine(run.items, false, false, state.open)}`;
      if (state.open) {
        // All the items, in the live region, bounded by the viewport.
        const rows = capOpenRows(openGroupRows({ id: gid, header: head, items: items(true), state, width: conversationInner }), gid, Math.max(4, p.viewportRows() - 8));
        return { id, done: false, responseOffset: first.responseOffset, ...order, lines: ['', ...rows] };
      }
      const under = folded.slice(-LIVE_SHOWN_CALLS).map((member) => underCall(liveItemLine(member, ended)));
      return { id, done: false, responseOffset: first.responseOffset, ...order, lines: tagged(['', head, ...under], gid, '') };
    }
    const header = callRow(summaryLine(run.items, false, false, state.open), conversationInner);
    const lines = state.open ? openGroupRows({ id: gid, header, items: items(false), state, width: conversationInner }) : tagged([header], gid, '');
    return { id, done: true, responseOffset: first.responseOffset, ...order, lines: ['', ...lines] };
  };
  /** The group's identity for its expansion state and its rows' tags: the
   * first call's id, which a saved turn keeps (a thought's key is made up
   * live and is a mark's id once saved, so it is not used while a call can be). */
  const groupIdOf = (run: CallRun<ActivityEntry & GroupRow>): string => (run.items.find((item) => !item.thought) ?? run.items[0]!).key;
  /** An item's identity in its group: a call's id, a thought's place among the items. */
  const itemIdOf = (item: ActivityEntry & GroupRow, index: number): string => (item.thought ? `thought:${index}` : item.key);
  /** One run's rows: a group row when two or more of its items fold, else
   * each item as the row it always was -- a lone call is its own summary. */
  const runRows = (run: CallRun<ActivityEntry & GroupRow>, ended: boolean): SettlingTool[] => {
    const alones = run.items.filter((item) => standsAlone(item, waitingOnApproval));
    const folded = run.items.filter((item) => !standsAlone(item, waitingOnApproval));
    const single = (item: ActivityEntry & GroupRow, held: boolean): SettlingTool => {
      const row = toolRow(item, ended);
      return { ...row, ...(held && row.done ? { done: false } : {}) };
    };
    if (folded.length < 2) return run.items.map((item) => single(item, !run.done && !alones.includes(item)));
    // The calls that stand alone register first: the group is the run's latest, for Ctrl+O.
    const aloneRows = alones.map((item) => single(item, false));
    const gid = groupIdOf(run);
    p.callGroups.set({ id: gid, items: folded.map((item, index) => ({ id: itemIdOf(item, index), entry: item })), running: !run.done && run.items.some((item) => item.event.kind === 'tool-start') });
    return [groupRow(run, folded, ended, `grp:${run.key}`, gid), ...aloneRows];
  };
  /** The turn's rows, runs of calls and thoughts grouped. A finished call
   * waits in the live region while its run is open: the next may join it. */
  const groupedRows = (entries: readonly ActivityEntry[], ended: boolean, grouping: CallGrouping, breaks: readonly number[] = [], children?: (id: string) => ActivityEntry[]): SettlingTool[] => {
    childrenOf = children ?? liveChildrenOf;
    // A row of its own that never joins a run: a note (lines and no event,
    // from activity()), a plan or notice, or a call the user refused, whose
    // row says so.
    const alone = (entry: ActivityEntry): boolean => !entry.event || refused(entry) || (entry.event.kind === 'thinking' && !entry.thought);
    const rows = entries.flatMap((entry) => (entry.event && !alone(entry) ? [{ ...entry, event: entry.event, key: entry.event.id ?? `activity#${entry.sequence ?? entry.responseOffset}` }] : []));
    const runs = grouping.group(rows, ended, ended ? Number.POSITIVE_INFINITY : p.liveResponse.length, breaks);
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
    const kept = readTurnActivities(message.activities, message.content.length).filter((activity) => activity.event.parentId);
    let subCalls: ActivityEntry[] = [];
    for (const activity of kept) subCalls = upsertActivityEvent(subCalls, index, 0, activity.event, 0, 0);
    return groupedRows(entries, true, new CallGrouping(), [], (id) => subCalls.filter((child) => child.event?.parentId === id));
  };
  const turnTools = (ended: boolean): SettlingTool[] => {
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
    const tools: SettlingTool[] = groupedRows(turnEntries(p.activityAnchor)
      // An anchor is reused: the next turn's assistant occupies the same
      // index when the previous one was never persisted. The turn that
      // produced an entry is what decided whether it belongs to this one.
      .filter((entry) => (entry.sequence ?? 0) > p.emitted.turnSequenceFloor), ended, p.callGrouping,
    // Where each steer of this window was acknowledged: it ends the run before it.
    p.waitingSubmissions.flatMap((item) => (item.state === 'steered' && item.ack ? [item.ack.sequence] : [])));
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

