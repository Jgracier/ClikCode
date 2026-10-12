/** Approvals and questions: where they were asked, and what became of them. */
import type { Decision } from '../../../../src/harness/protocol/turn-flow';
import { takeSeq } from './activity';
import { resumed } from './clock';
import type { Approval, ChatModel, Decided, DecisionEntry, LiveTurn } from './types';


/** Where a request was asked, from what the worker sent with it and the
 * vendor's call it names, if any (an older worker sends neither). */
export function askedAt(model: ChatModel, event: { seq?: number; responseOffset?: number; callId?: string }): Partial<Pick<Approval, 'seq' | 'offset' | 'callId'>> {
  return {
    ...(typeof event.seq === 'number' ? { seq: event.seq } : {}),
    ...(typeof event.responseOffset === 'number' ? { offset: event.responseOffset } : {}),
    ...(event.callId ? { callId: event.callId } : {}),
  };
}

export function answeredApproval(model: ChatModel, id: string, decided?: Decided): ChatModel {
  const approval = model.approvals.find((item) => item.id === id);
  const approvals = model.approvals.filter((item) => item.id !== id);

  // Time spent on the user's answer is not the turn going quiet, and not
  // the turn's time: the clock runs again once none is waiting.
  const live = model.live && { ...model.live, activeAt: Date.now(), ...(approvals.length || model.signIn ? {} : resumed(model.live)) };
  const settled = live && decided ? withDecision(live, id, approval, decided) : live;
  return { ...model, approvals, ...(settled ? { live: settled } : {}) };
}

/** The decision recorded as a row of the turn, under the id the worker's own
 * `outcome` mark has, so the two are one row. */
export function withDecision(live: LiveTurn, id: string, approval: Approval | undefined, decided: Decided): LiveTurn {
  const entryId = `outcome:${id}`;
  const held = live.decisions?.find((entry) => entry.id === entryId);
  const label = decided.label ?? approval?.title ?? (held && 'label' in held.decision ? held.decision.label : undefined) ?? 'request';
  const decision: Decision = decided.told ? { kind: 'told', text: decided.told }
    : decided.outcome === 'approved' ? { kind: 'approved', label, ...(decided.always || (held?.decision.kind === 'approved' && held.decision.always) ? { always: true } : {}) }
      : decided.outcome === 'answered' ? { kind: 'answered', label }
        : decided.outcome === 'declined' ? { kind: 'declined', label } : { kind: 'denied', label };
  if (held) {
    // Told and declined are this window's own knowledge: the worker's plain
    // "denied" does not take them back.
    const keep = held.decision.kind === 'told' || held.decision.kind === 'declined';
    return { ...live, decisions: live.decisions!.map((entry) => (entry.id === entryId ? { ...entry, decision: keep ? entry.decision : decision } : entry)) };
  }
  const taken = takeSeq(live, approval?.seq);
  const entry: DecisionEntry = {
    id: entryId, decision, offset: Math.min(approval?.offset ?? live.text.length, live.text.length), seq: taken.seq,
    ...(approval?.callId || decided.callId ? { callId: (approval?.callId ?? decided.callId)! } : {}),
  };
  return { ...live, seen: taken.seen, decisions: [...(live.decisions ?? []), entry] };
}
