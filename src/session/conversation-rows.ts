/** The conversation list, as rows: one per conversation, in its section.
 *
 * The terminal's /resume board and the editor's history menu draw the same
 * list. Both used to group chats by conversation, decide what each was doing
 * and rank the sections on their own, with the 24-hour cutoff written twice.
 * This is the one place that does it; each surface only draws the rows.
 *
 *   working  a turn is generating (a live worker and its transcript turn)
 *   active   something happened on it in the last 24 hours (titled Recent)
 *   past     older (titled Older)
 *
 * What a row says it is doing is conversation-state.ts.
 */

import { hostname } from 'node:os';
import type { HarnessSession } from './model.js';
import { sessionActivity, type WorkerLiveness } from './liveness.js';
import type { ConversationSection } from './conversation-state.js';

export { SECTION_TITLES, type ConversationSection } from './conversation-state.js';

type PendingTurn = NonNullable<HarnessSession['pendingTurn']>;

/** A chat counts as Active when something happened on it in this window. */
export const ACTIVE_WITHIN_MS = 24 * 60 * 60 * 1000;

const SECTION_RANK: Readonly<Record<ConversationSection, number>> = { working: 0, active: 1, past: 2 };

export function sectionRank(section: ConversationSection): number {
  return SECTION_RANK[section];
}

/** The conversation a chat belongs to: its root (forks share it). */
export function conversationIdFor(session: HarnessSession): string {
  return session.conversationId ?? session.id;
}

/** Active or Past, by when it last changed. No timestamp is Past. */
export function recencySection(updatedAtMs: number | undefined, now: number): 'active' | 'past' {
  return updatedAtMs !== undefined && Number.isFinite(updatedAtMs) && now - updatedAtMs < ACTIVE_WITHIN_MS ? 'active' : 'past';
}

export interface ConversationRow {
  root: string;
  /** Every chat in the conversation (it and its forks). */
  chats: HarnessSession[];
  /** The chat the row opens: the newest still active, else the newest. */
  latest: HarnessSession;
  /** Newest change across its chats; -Infinity when none parses. */
  updatedAtMs: number;
  /** `working` while a turn generates; `idle` when something holds it open
   * (the chat open here always counts). */
  activity?: 'working' | 'idle';
  /** The generating turn, when `working`. */
  pending?: PendingTurn;
  /** An approval in one of its chats is waiting on the user. */
  needsYou: boolean;
  /** It holds the chat open here. */
  current: boolean;
  section: ConversationSection;
}

export interface ConversationRowFacts {
  /** Which sessions have a worker process (liveWorkerSessions). */
  workerIsLive?: WorkerLiveness;
  /** Which live workers have an approval waiting (liveWorkers). */
  awaitingYou?: WorkerLiveness;
  /** Transcript turns of live-worker sessions (livePendingTurns). */
  pending?: ReadonlyMap<string, PendingTurn>;
  currentId?: string;
  now?: number;
  host?: string;
}

const timestamp = (value: string): number => {
  const at = Date.parse(value);
  return Number.isNaN(at) ? -Infinity : at;
};

/** One row per conversation: Working first, then Recent, then Older; within
 * each, one that needs the user first, then newest first. A clerk (a swarm's helper chat) is never a row. Which
 * chats count as conversations at all (blank ones) is the caller's filter. */
export function conversationRows(sessions: readonly HarnessSession[], facts: ConversationRowFacts = {}): ConversationRow[] {
  const now = facts.now ?? Date.now();
  const host = facts.host ?? hostname();
  const workerIsLive = facts.workerIsLive ?? (() => false);
  const groups = new Map<string, HarnessSession[]>();
  for (const session of sessions) {
    if (session.clerkOf || session.foldedInto) continue;
    const root = conversationIdFor(session);
    const group = groups.get(root);
    if (group) group.push(session);
    else groups.set(root, [session]);
  }
  const rows: ConversationRow[] = [];
  for (const [root, chats] of groups) {
    const newest = (list: readonly HarnessSession[]): HarnessSession => list.reduce((best, item) => (timestamp(item.updatedAt) > timestamp(best.updatedAt) ? item : best));
    const open = chats.filter((session) => session.status === 'active');
    const latest = newest(open.length ? open : chats);
    const updatedAtMs = Math.max(...chats.map((session) => timestamp(session.updatedAt)));
    const current = facts.currentId !== undefined && chats.some((session) => session.id === facts.currentId);
    // Per conversation, not per chat: a fork's worker is this conversation's
    // too.
    let activity: ConversationRow['activity'];
    let pending: PendingTurn | undefined;
    for (const session of chats) {
      const turn = facts.pending?.get(session.id);
      const doing = sessionActivity(session, workerIsLive, now, host, turn);
      if (doing === 'working' && turn) { activity = 'working'; pending = turn; break; }
      if (doing) activity = doing;
    }
    // The chat open here is active by definition; a claim only says whether
    // someone ELSE holds it, so it would not show up by liveness alone.
    if (!activity && current) activity = 'idle';
    const needsYou = Boolean(facts.awaitingYou && chats.some((session) => facts.awaitingYou!(session.id)));
    const section: ConversationSection = activity === 'working' ? 'working' : recencySection(updatedAtMs, now);
    rows.push({ root, chats, latest, updatedAtMs, ...(activity ? { activity } : {}), ...(pending ? { pending } : {}), needsYou, current, section });
  }
  return rows.sort((left, right) => sectionRank(left.section) - sectionRank(right.section)
    || Number(right.needsYou) - Number(left.needsYou) || right.updatedAtMs - left.updatedAtMs);
}
