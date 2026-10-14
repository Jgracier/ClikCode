/** A worker snapshot of a running turn, folded into the window's own live turn. */
import { backgroundWorkOf } from '../../../../src/harness/protocol/background-agents';
import { isApprovalWaitPhase } from '../../../../src/harness/protocol/turn-flow';
import { stripAnsi } from '../text';
import { freshLive, liveBackground, stampAfter, upsertActivity, withToolPhase, withWorkerThought } from './activity';
import { marksToRows, mergeDecisions, mergeReasoning } from './marks';
import { withNoticeMarks } from './notes';
import { applySession } from './session';
import { endTurn } from './traces';
import type { WorkerEvent } from '../protocol';
import type { ChatModel, LiveTurn } from './types';

/** The worker attaches `live` to every snapshot while a turn runs. */
export function applySnapshot(model: ChatModel, event: Extract<WorkerEvent, { type: 'snapshot' }>): ChatModel {

  const next = applySession(model, event.session, event.account);
  // The worker attaches `live` to every snapshot while a turn runs, so
  // one without it says nothing is running there.
  // `stopped`: another window or the CLI stopped it -- ended as stopped.
  if (!event.live) return model.live ? endTurn({ ...next, pendingPrompt: undefined }, event.stopped === true) : next;
  // The running turn's tool rows and plan come with it (from ClikCode
  // builds that send them), so a panel opened mid-turn shows them too.
  // Joined mid-turn, the clock starts where the turn really did.
  const startedAt = Date.parse(event.session.pendingTurn?.startedAt ?? '') || undefined;
  const base = next.live ?? freshLive('', startedAt);
  // A snapshot adds and updates; it does not erase what only this window
  // held (the thoughts -- never in a snapshot -- and each running call's
  // clock). Calls merge by id, so a finished one is never reopened.
  const replayed = event.live.activities
    ? event.live.activities.reduce<LiveTurn>((live, item) => withToolPhase(upsertActivity(live, item.event, item.responseOffset), item.event), base)
    : base;
  // What the worker holds that a window cannot have seen: its settled
  // thoughts, the plan, the notices and decisions in their own order, and
  // the thought being had. The worker's rows are authoritative for the
  // rows they carry; what only this window held stays.
  const rows = marksToRows(event.live.marks);
  const folded = withWorkerThought({
    ...replayed, reasoning: mergeReasoning(replayed.reasoning, rows.reasoning),
    ...(mergeDecisions(replayed.decisions, rows.decisions) ? { decisions: mergeDecisions(replayed.decisions, rows.decisions)! } : {}),
    ...(rows.plan ? { planAt: rows.plan.at } : {}),
    seen: Math.max(replayed.seen, ...rows.reasoning.map((entry) => entry.seq), ...rows.decisions.map((entry) => entry.seq), rows.plan?.at.seq ?? 0, ...rows.notices.map((entry) => entry.seq)),
  }, event.live.thought);
  // Steers are the turn's own record, so every window shows them.
  // Each takes its place in the order when it was acknowledged: the
  // worker's `seq` where it sends one, else the order this window first
  // saw it in (the earlier window's, kept).
  let seen = folded.seen;
  // Merged with what this window already placed, by id: a snapshot read
  // before the steer was persisted does not take it away, and the same steer
  // is one row whichever copy arrives first. Without an id (an older
  // worker) the place in the list is all there is to match by.
  const held = model.live?.steers ?? [];
  const durable = event.session.pendingTurn?.steers ?? [];
  const merged = durable.map((steer, index) => {
    const local = steer.id ? held.find((item) => item.id === steer.id) : held[index]?.id ? undefined : held[index];
    const seq = steer.seq ?? local?.seq ?? ++seen;
    seen = Math.max(seen, seq);
    return { ...(steer.id ? { id: steer.id } : {}), text: steer.text, offset: steer.responseOffset ?? local?.offset ?? event.live!.text.length, seq };
  });
  const steers = [...merged, ...held.filter((item) => item.id && !durable.some((steer) => steer.id === item.id))];
  // The plan the worker says the turn has is placed where this window
  // first saw it (or, joining mid-turn, at the top, as it was drawn
  // before). `planOffset` is where the worker says it really was (absent
  // from an older worker).
  const planAt = folded.planAt ?? (event.live.plan?.length ? { offset: event.live.planOffset ?? 0, seq: ++seen } : undefined);
  // Joined mid-answer: text that came after the turn's last call is
  // being written; the window did not see it arrive, so it says so now.
  const lastCall = folded.activities.reduce((last, item) => Math.max(last, item.offset ?? 0), 0);
  const answering = event.live.text.length > 0 && event.live.text.length > lastCall;
  const grew = event.live.text.length > (model.live?.text.length ?? 0);
  const writing = answering && (folded.writingAt === undefined || grew) ? { writingAt: stampAfter(folded.callAt) } : {};
  // The turn's phase, only while it has not begun to answer, and never the
  // adapters' "waiting for your approval" (stale once it is answered).
  const reported = event.live.phase ? stripAnsi(event.live.phase) : undefined;
  const phase = folded.phase ?? (reported && !event.live.text && !isApprovalWaitPhase(reported) ? reported : undefined);
  const turnIndex = next.turnUserIndex ?? next.messages.length;
  return {
    ...next,
    running: true,
    turnUserIndex: turnIndex,
    notes: withNoticeMarks(next.notes, turnIndex, rows.notices),
    live: {
      ...folded, text: event.live.text, waitingLabel: stripAnsi(event.live.waitingLabel), steers, seen, ...(planAt ? { planAt } : {}), ...writing,
      ...(phase ? { phase } : {}),
      ...liveBackground(backgroundWorkOf(event.live)),
    },
    ...(event.live.usage ? { turnUsage: { ...event.live.usage, ...next.turnUsage } } : {}),
    ...(event.live.plan ? { plan: event.live.plan.map((entry) => ({ content: stripAnsi(entry.content), ...(entry.status ? { status: entry.status } : {}) })) }
      : rows.plan && !next.plan.length ? { plan: rows.plan.entries } : {}),
  };

}
