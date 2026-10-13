/** A finished turn's trace: the live turn kept beside its answer, and the saved turn's own record. */
import { backgroundWorkOf } from '../../../../src/harness/protocol/background-agents';
import { endsWithSummary } from '../../../../src/harness/protocol/turn-flow';
import { readTurnActivities } from '../../../../src/turn/turn-activities';
import { freshLive, settledCalls, upsertActivity, withoutClock } from './activity';
import { liveElapsedMs } from './clock';
import { marksToRows, mergeDecisions, mergeReasoning, turnReasoning } from './marks';
import type { HarnessSession } from '../protocol';
import type { ChatModel, LiveTurn, TurnTrace } from './types';


export const MAX_TRACES = 100;

/** The calls each saved turn kept, as the traces the transcript draws them
 * from. The saved copy wins over this window's own record of the same turn
 * -- its calls and the text they are placed in -- while the reasoning and
 * plan only this window saw stay. Unchanged, the same list comes back, so
 * the page does not redraw the history. */
export function withSavedTraces(traces: TurnTrace[], messages: NonNullable<HarnessSession['messages']>): TurnTrace[] {
  const byUser = new Map(traces.map((trace) => [trace.userIndex, trace]));
  let changed = false;
  messages.forEach((message, index) => {
    if (message.role !== 'assistant') return;
    const saved = readTurnActivities(message.activities, message.content.length);
    // The worker's own record of how the turn ended: what the live window
    // said ("Worked for 1m 2s", "Stopped after 3s"), said again on reopen.
    const end = message.turnEnd;
    const work = backgroundWorkOf(end);
    const pendingBackground = work?.agents ?? 0;
    const pendingWorkflows = work?.workflows ?? 0;
    const ended = end ? {
      startedAt: 0, endedAt: Math.max(0, end.ms), ...(end.stopped ? { stopped: true as const } : {}),
      ...(end.usage ? { usage: end.usage } : {}), ...(pendingBackground ? { pendingBackground } : {}),
      ...(pendingWorkflows ? { pendingWorkflows } : {}),
    } : undefined;
    // The worker's durable marks: thoughts, plan, notices, decisions.
    const rows = marksToRows(message.marks);
    const hasMarks = rows.reasoning.length > 0 || Boolean(rows.plan) || rows.notices.length > 0 || rows.decisions.length > 0;
    // A turn with no calls has a trace only to carry its closing line.
    if (!saved.length && !hasMarks && !(ended && (ended.stopped || ended.pendingBackground || ended.pendingWorkflows || endsWithSummary(ended.endedAt, 0)))) return;
    // Folded by the same upsert live frames go through.
    const activities = settledCalls(saved.reduce<LiveTurn>(
      (live, item) => upsertActivity(live, item.event, Math.min(item.responseOffset, message.content.length)), freshLive(''),
    ).activities.map(withoutClock), false);
    const prior = byUser.get(index - 1);
    const stopped = ended?.stopped || activities.some((activity) => activity.stopped);
    // The worker's marks are authoritative for the rows they carry; what only
    // this window recorded (a longer reasoning text) stays.
    const reasoning = rows.reasoning.length ? mergeReasoning(prior?.reasoning ?? [], rows.reasoning) : prior?.reasoning;
    const decisions = mergeDecisions(prior?.decisions, rows.decisions);
    const next: TurnTrace = {
      startedAt: 0, endedAt: 0, ...ended, ...prior, userIndex: index - 1, activities, text: message.content, saved: true, ...(stopped ? { stopped: true } : {}),
      ...(reasoning?.length ? { reasoning } : {}),
      ...(rows.plan ? { plan: rows.plan.entries, planAt: rows.plan.at } : {}),
      ...(rows.notices.length ? { notices: rows.notices } : {}),
      ...(decisions?.length ? { decisions } : {}),
    };
    if (prior && JSON.stringify(prior) === JSON.stringify(next)) return;
    byUser.set(index - 1, next);
    changed = true;
  });
  return changed ? [...byUser.values()].sort((left, right) => left.userIndex - right.userIndex).slice(-MAX_TRACES) : traces;
}

/** The turn is over: its tool rows are kept beside the answer. */
export function endTurn(model: ChatModel, stoppedElsewhere = false): ChatModel {
  const asked = Boolean(model.live?.stopping) || stoppedElsewhere;
  const activities = settledCalls(model.live?.activities ?? [], asked);
  const reasoning = turnReasoning(model.live);
  const plan = model.plan.length ? model.plan : undefined;
  const turnNotes = model.notes.some((note) => note.turn !== undefined && note.turn === model.turnUserIndex);
  // The saved turn's calls, when its snapshot came first, win over the ones
  // this window watched (see withSavedTraces).
  const saved = model.traces.find((trace) => trace.userIndex === model.turnUserIndex && trace.saved);
  const decisions = model.live?.decisions?.length ? model.live.decisions : undefined;
  const traces = (activities.length || reasoning || plan || turnNotes || decisions || model.live?.pendingBackground || model.live?.background?.workflows || (asked && model.live?.text)) && model.turnUserIndex !== undefined
    ? [...model.traces.filter((trace) => trace.userIndex !== model.turnUserIndex), {
      userIndex: model.turnUserIndex, activities, ...(reasoning ? { reasoning } : {}), ...(decisions ? { decisions } : {}), ...(plan ? { plan, planAt: model.live?.planAt ?? { offset: 0, seq: 0 } } : {}),
      // Completed steers are materialized as user messages in session.messages.
      // Keeping the live badges in the finished trace displayed each prompt twice.
      ...(model.turnUsage ? { usage: model.turnUsage } : {}),
      ...(model.live?.pendingBackground ? { pendingBackground: model.live.pendingBackground } : {}),
      ...(model.live?.background?.workflows ? { pendingWorkflows: model.live.background.workflows } : {}),
      text: model.live?.text ?? '',
      // Less the time approvals waited, as the terminal's summary counts.
      startedAt: model.live ? Date.now() - liveElapsedMs(model.live, Date.now()) : Date.now(), endedAt: Date.now(),
      ...(saved ? { activities: saved.activities, text: saved.text, saved: true } : {}),
      ...(asked || (saved ?? { activities }).activities.some((activity) => activity.stopped) ? { stopped: true } : {}),
    }].slice(-MAX_TRACES)
    : model.traces;
  // The plan goes with its turn (the trace holds it, at its place): left
  // here an unfinished one drew a second card under the answer.
  return { ...model, running: false, live: undefined, ownTurn: undefined, turnUserIndex: undefined, traces, plan: [] };
}
