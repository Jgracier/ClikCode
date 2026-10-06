/** What one conversation is doing, in a few words: the middle part of every
 * conversation row -- the terminal's board and /resume, and VS Code's history
 * menu -- so the surfaces cannot word it differently.
 *
 *   working 3m · 2 agents   a turn is generating (and sub-agents are out)
 *   stalled 4m              that turn has been quiet past turn-pace's threshold
 *   needs you               an approval is waiting on the user
 *   back 2:30PM             a turn parked until the quota resets
 *   5m ago                  otherwise, when it last changed
 *
 * Chalk free and dependency free, so the webview bundle can import it. */

import { quotaResetPhrase, relativeTime, formatElapsed } from '../harness/protocol/format.js';
import { turnStalled } from '../harness/protocol/turn-pace.js';

/** Where a row is listed: generating, changed in the last 24 hours, older.
 * The keys are on the IDE protocol (IdeConversation.section); only the
 * titles are words. */
export type ConversationSection = 'working' | 'active' | 'past';

export const SECTION_TITLES: Readonly<Record<ConversationSection, string>> = { working: 'Working', active: 'Recent', past: 'Older' };

/** A generating turn, as much of it as a row needs. */
export interface TurnFacts {
  startedAt: string;
  /** When it last did anything, its sub-agents included (turnActiveAt). */
  activeAt: string;
  /** Sub-agents running inside it. */
  agents?: number;
}

export interface ConversationStateFacts {
  updatedAt: string;
  turn?: TurnFacts;
  needsYou?: boolean;
  /** A turn parked for the quota reset: when it sends again. */
  resumeAt?: string;
}

export type ConversationStateKind = 'working' | 'stalled' | 'needs-you' | 'back' | 'idle';

export interface ConversationState {
  kind: ConversationStateKind;
  text: string;
}

type PendingTurnShape = {
  startedAt: string; updatedAt: string;
  subagents?: ReadonlyArray<{ startedAt: string; stepAt?: string }>;
};

const parsed = (iso: string | undefined): number => {
  const at = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(at) ? -Infinity : at;
};

/** When a generating turn last did anything. A sub-agent's own steps are
 * not written to the turn's `updatedAt`, so a turn whose agents are busy
 * would otherwise read as stalled while they work. */
export function turnActiveAt(pending: PendingTurnShape): string {
  let latest = pending.updatedAt;
  for (const agent of pending.subagents ?? []) {
    const at = agent.stepAt ?? agent.startedAt;
    if (parsed(at) > parsed(latest)) latest = at;
  }
  return latest;
}

/** A transcript's turn in flight as the facts a row needs. */
export function turnFacts(pending: PendingTurnShape): TurnFacts {
  const agents = pending.subagents?.length ?? 0;
  return { startedAt: pending.startedAt, activeAt: turnActiveAt(pending), ...(agents ? { agents } : {}) };
}

/** The one state a row shows: needing the user outranks everything, then a
 * running turn, then a parked one, then how long ago. */
export function conversationState(facts: ConversationStateFacts, now: number): ConversationState {
  if (facts.needsYou) return { kind: 'needs-you', text: 'needs you' };
  if (facts.turn) {
    const active = parsed(facts.turn.activeAt);
    const quiet = Number.isFinite(active) ? now - active : 0;
    if (turnStalled(quiet)) return { kind: 'stalled', text: `stalled ${formatElapsed(quiet)}` };
    const agents = facts.turn.agents ?? 0;
    const started = parsed(facts.turn.startedAt);
    return {
      kind: 'working',
      text: `working${Number.isFinite(started) ? ` ${formatElapsed(now - started)}` : ''}${agents ? ` · ${agents} agent${agents === 1 ? '' : 's'}` : ''}`,
    };
  }
  if (facts.resumeAt && Number.isFinite(parsed(facts.resumeAt))) {
    return { kind: 'back', text: `back ${quotaResetPhrase(new Date(facts.resumeAt), now)}` };
  }
  return { kind: 'idle', text: relativeTime(facts.updatedAt, now) };
}
