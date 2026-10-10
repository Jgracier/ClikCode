/** What is happening in the user's other conversations right now.
 *
 * Built only from records that already exist and expire on their own: the
 * worker registry (which pid runs which chat, and the approval it waits
 * on), the claims (which chat a window holds open), and the turn journal of
 * the chats a live worker runs (its prompt and tool calls so far). Nothing
 * is spawned, attached to or written. */

import { hostname } from 'node:os';
import type { HarnessSession } from '../session/model.js';
import { readSessionClaims } from '../session/claims.js';
import { livePendingTurns, sessionActivity } from '../session/liveness.js';
import { listWorkerRecords } from '../worker/registry.js';
import { readTurnActivities } from '../turn/turn-activities.js';
import { conversationGroups, conversationTitle } from './conversations.js';

/** A chat that changed this recently counts as recent work, live or not. */
export const RECENT_WITHIN_MS = 2 * 60 * 60 * 1000;

export interface ActiveConversation {
  conversationId: string;
  sessionId: string;
  title: string;
  provider: string | null;
  model: string | null;
  harness?: string;
  /** working: a turn is running. open: a window or worker holds it between
   * turns. recent: nothing holds it, but it changed recently. */
  state: 'working' | 'open' | 'recent';
  lastAsk?: string;
  /** The running turn's current step: the call in flight, else the last one. */
  step?: string;
  /** Sub-agents the running turn has out, with their own steps. */
  subagents?: string[];
  turnStartedAt?: string;
  awaitingApproval?: { title: string; since: string };
  updatedAt: string;
  updatedAtMs: number;
}

export interface ActiveOptions {
  excludeConversationId?: string;
  excludeSessionId?: string;
  now?: number;
  limit?: number;
}

const oneLine = (text: string, limit: number): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};

function stepOf(turn: NonNullable<HarnessSession['pendingTurn']>): string | undefined {
  const calls = readTurnActivities(turn.activities, turn.response?.length ?? 0);
  const running = [...calls].reverse().find((call) => call.event.kind === 'tool-start' && !call.event.parentId);
  if (running) return `running ${oneLine(running.event.label, 120)}`;
  const last = calls.at(-1);
  if (turn.response?.trim() && (!last || last.responseOffset < turn.response.length)) return 'writing its answer';
  if (last) return `after ${oneLine(last.event.label, 120)}${last.event.kind === 'tool-error' ? ' (failed)' : ''}`;
  return turn.outputStarted ? 'working' : 'thinking';
}

function latest(updatedAt: string, updatedAtMs: number, turnAt: string | undefined): { updatedAt: string; updatedAtMs: number } {
  const turnMs = turnAt ? Date.parse(turnAt) : Number.NaN;
  return turnMs > updatedAtMs ? { updatedAt: turnAt!, updatedAtMs: turnMs } : { updatedAt, updatedAtMs };
}

export async function activeConversations(options: ActiveOptions = {}): Promise<ActiveConversation[]> {
  const now = options.now ?? Date.now();
  const host = hostname();
  const [groups, claims, records] = await Promise.all([
    conversationGroups(), readSessionClaims().catch(() => new Map()), listWorkerRecords().catch(() => []),
  ]);
  const live = new Set<string>();
  const approvals = new Map<string, { title: string; since: string }>();
  for (const record of records) {
    try {
      process.kill(record.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') continue;
    }
    live.add(record.sessionId);
    if (record.awaitingApproval) approvals.set(record.sessionId, record.awaitingApproval);
  }
  const workerIsLive = (id: string): boolean => live.has(id);
  const candidates = groups.filter((group) => group.id !== options.excludeConversationId
    && !group.branches.some((branch) => branch.id === options.excludeSessionId));
  const sessions = candidates.flatMap((group) => group.branches.map((branch) => {
    const claim = claims.get(branch.id);
    return claim
      ? { ...branch, claim: { pid: claim.pid, host: claim.host, startedAt: claim.startedAt, heartbeatAt: claim.heartbeatAt } }
      : branch;
  }));
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const pending = await livePendingTurns(sessions, workerIsLive);
  const out: ActiveConversation[] = [];
  for (const group of candidates) {
    let chosen: HarnessSession | undefined;
    let state: ActiveConversation['state'] | undefined;
    for (const branch of group.branches) {
      const session = byId.get(branch.id)!;
      const doing = sessionActivity(session, workerIsLive, now, host, pending.get(session.id));
      if (doing === 'working') { chosen = session; state = 'working'; break; }
      if (doing && !state) { chosen = session; state = 'open'; }
    }
    if (!state && now - group.updatedAtMs <= RECENT_WITHIN_MS) { chosen = group.newest; state = 'recent'; }
    if (!chosen || !state) continue;
    const turn = state === 'working' ? pending.get(chosen.id) : undefined;
    const approval = approvals.get(chosen.id);
    const ask = turn?.prompt ?? chosen.listPreview;
    out.push({
      conversationId: group.id, sessionId: chosen.id, title: conversationTitle(group.newest),
      provider: chosen.provider ?? null, model: chosen.model ?? null,
      ...(chosen.nativeHarness ? { harness: chosen.nativeHarness } : {}),
      state,
      ...(ask?.trim() ? { lastAsk: oneLine(ask, 200) } : {}),
      ...(turn ? { step: stepOf(turn), turnStartedAt: turn.startedAt } : {}),
      ...(turn?.subagents?.length ? { subagents: turn.subagents.map((agent) => oneLine(`${agent.label}${agent.step ? `: ${agent.step}` : ''}`, 120)) } : {}),
      ...(approval ? { awaitingApproval: approval } : {}),
      // A running turn is newer than the transcript it has not saved yet.
      ...latest(group.newest.updatedAt, group.updatedAtMs, turn?.updatedAt),
    });
  }
  const rank = { working: 0, open: 1, recent: 2 } as const;
  out.sort((left, right) => Number(Boolean(right.awaitingApproval)) - Number(Boolean(left.awaitingApproval))
    || rank[left.state] - rank[right.state] || right.updatedAtMs - left.updatedAtMs);
  return out.slice(0, options.limit ?? 12);
}
