/** Durable, provider-neutral representation of a turn that has started but
 * has not reached a successful provider completion yet. */

import type { HarnessActivityEvent, HarnessSession } from './types.js';
import type { LiveTurnSubmission } from './live-turn-input.js';

type Message = NonNullable<HarnessSession['messages']>[number];

function activitySummary(activities: readonly string[]): string {
  return `Interrupted turn activity: ${activities.join('; ')}. Inspect the current workspace before continuing.`;
}

/** Materialize an in-flight turn without mutating the session. This is used by
 * rendering, history, and provider handoff so a process/provider failure never
 * makes submitted work disappear from the portable conversation. */
export function sessionTranscriptMessages(session: HarnessSession): Message[] {
  const messages = [...(session.messages ?? [])];
  const pending = session.pendingTurn;
  if (!pending) return messages;
  messages.push({ role: 'user', content: pending.prompt });
  const response = pending.response ?? '';
  let responseOffset = 0;
  for (const steer of [...(pending.steers ?? [])].sort((left, right) => (left.responseOffset ?? 0) - (right.responseOffset ?? 0))) {
    const steerOffset = Math.max(responseOffset, Math.min(response.length, steer.responseOffset ?? 0));
    const beforeSteer = response.slice(responseOffset, steerOffset);
    if (beforeSteer.trim()) messages.push({ role: 'assistant', content: beforeSteer });
    messages.push({ role: 'user', content: steer.text });
    responseOffset = steerOffset;
  }
  const remaining = response.slice(responseOffset);
  if (remaining.trim()) messages.push({ role: 'assistant', content: remaining });
  else if (!response.trim() && pending.activities?.length) messages.push({ role: 'assistant', content: activitySummary(pending.activities) });
  return messages;
}

/** Starting another turn commits an older interrupted checkpoint first. */
export function beginPendingTurn(session: HarnessSession, prompt: string, now: string): void {
  if (session.pendingTurn) session.messages = sessionTranscriptMessages(session);
  session.pendingTurn = { prompt, startedAt: now, updatedAt: now, outputStarted: false };
  session.updatedAt = now;
}

export function updatePendingResponse(
  session: HarnessSession, text: string, mode: 'append' | 'replace', now: string,
): void {
  const pending = session.pendingTurn;
  if (!pending || (!text && mode === 'append')) return;
  if (!text) delete pending.response;
  else pending.response = mode === 'replace' ? text : `${pending.response ?? ''}${text}`;
  pending.outputStarted = Boolean(text || pending.activities?.length);
  pending.updatedAt = now;
  session.updatedAt = now;
}

export function recordPendingActivity(session: HarnessSession, event: HarnessActivityEvent, now: string): void {
  const pending = session.pendingTurn;
  if (!pending || event.kind === 'thinking') return;
  const verb = event.kind === 'tool-error' ? 'failed'
    : event.kind === 'tool-done' ? 'completed' : event.kind === 'tool-start' ? 'started' : 'thinking';
  const summary = `${verb} ${event.label}`.trim();
  if (!summary || pending.activities?.[pending.activities.length - 1] === summary) return;
  pending.activities = [...(pending.activities ?? []).slice(-19), summary];
  pending.outputStarted = true;
  pending.updatedAt = now;
  session.updatedAt = now;
}

export function recordPendingSteer(
  session: HarnessSession, text: string, submittedAt: string, responseOffset: number, now: string,
): void {
  const pending = session.pendingTurn;
  if (!pending || !text.trim()) return;
  pending.steers = [...(pending.steers ?? []), { text: text.trim(), submittedAt, responseOffset: Math.max(0, responseOffset) }];
  pending.updatedAt = now;
  session.updatedAt = now;
}

export function enqueueSessionTurn(session: HarnessSession, submission: LiveTurnSubmission, now: string): void {
  if ((session.queuedTurns ?? []).some((item) => item.id === submission.id)) return;
  session.queuedTurns = [...(session.queuedTurns ?? []), submission];
  session.updatedAt = now;
}

export function consumeSessionTurn(session: HarnessSession, id: string): boolean {
  const queued = session.queuedTurns ?? [];
  const next = queued.filter((item) => item.id !== id);
  if (next.length === queued.length) return false;
  if (next.length) session.queuedTurns = next;
  else delete session.queuedTurns;
  return true;
}

export function finishPendingTurn(session: HarnessSession, response: string | undefined, now: string): void {
  if (!session.pendingTurn) return;
  if (response?.trim()) {
    session.pendingTurn.response = response.trim();
    session.pendingTurn.outputStarted = true;
  }
  session.messages = sessionTranscriptMessages(session);
  delete session.pendingTurn;
  session.updatedAt = now;
}

export function discardPendingTurn(session: HarnessSession, prompt?: string): boolean {
  if (!session.pendingTurn || (prompt !== undefined && session.pendingTurn.prompt !== prompt)) return false;
  delete session.pendingTurn;
  return true;
}
