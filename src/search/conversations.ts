/** The conversations search looks through: every stored chat from the index,
 * grouped by the conversation it belongs to. Read-only -- the index is read
 * as it is on disk and nothing is ever written back. */

import type { HarnessSession } from '../session/model.js';
import { groupByConversation } from '../session/conversation-rows.js';
import { loadIndex } from '../session/state/index-file.js';
import { normalizedStatus } from '../session/state/settings.js';

export interface ConversationGroup {
  id: string;
  /** Its chats (it and its forks), newest first. */
  branches: HarnessSession[];
  /** The newest branch: it names the conversation and is the one opened. */
  newest: HarnessSession;
  updatedAtMs: number;
}

const timestamp = (value: string | undefined): number => {
  const at = Date.parse(value ?? '');
  return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
};

/** A title for a conversation that was never named: what it was asked first. */
export function conversationTitle(session: HarnessSession, limit = 60): string {
  const raw = session.name?.trim() || session.listPreview?.trim() || '';
  const line = raw.replace(/\s+/g, ' ');
  if (!line) return '(untitled)';
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

export async function conversationGroups(): Promise<ConversationGroup[]> {
  const index = await loadIndex();
  const sessions = (index?.sessions ?? []) as unknown as HarnessSession[];
  const groups = groupByConversation(sessions.map((session) => ({ ...session, ...normalizedStatus(session) })));
  return [...groups].map(([id, branches]) => {
    branches.sort((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt));
    return { id, branches, newest: branches[0]!, updatedAtMs: timestamp(branches[0]!.updatedAt) };
  });
}

/** Finds a conversation or one of its chats by id, or by the start of one
 * (at least six characters), which is how results print them. */
export function findConversation(groups: readonly ConversationGroup[], id: string): { group: ConversationGroup; branch?: HarnessSession } | undefined {
  const wanted = id.trim().toLowerCase();
  if (wanted.length < 6) return undefined;
  for (const group of groups) {
    if (group.id.toLowerCase() === wanted) return { group };
    const branch = group.branches.find((session) => session.id.toLowerCase() === wanted);
    if (branch) return { group, branch };
  }
  const matches: Array<{ group: ConversationGroup; branch?: HarnessSession }> = [];
  for (const group of groups) {
    if (group.id.toLowerCase().startsWith(wanted)) { matches.push({ group }); continue; }
    const branch = group.branches.find((session) => session.id.toLowerCase().startsWith(wanted));
    if (branch) matches.push({ group, branch });
  }
  return matches.length === 1 ? matches[0] : undefined;
}
