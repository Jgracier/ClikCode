/** A conversation's summary, as builds before 2026-10-21 kept it.
 *
 * Conversations carry over whole now (no summary substitution): nothing makes
 * a summary any more. One an older build stored on a conversation is still
 * shown where it was (/export, a list row) while it describes the turns it
 * covers (`hash`): a redo, fork or edit that changes any of them retires it.
 *
 * The vendor thread readers below stay for what still asks which vendors keep
 * a readable compaction (readsVendorCompaction). */
import { createHash } from 'node:crypto';
import { canonicalRecord, type CanonicalRecord, type CanonicalTurn } from './canonical.js';
import type { HarnessSession } from './model.js';

export interface ConversationSummary {
  /** The summary, as the harness that made it wrote it (its own framing removed). */
  text: string;
  /** Turns [0, through) of the conversation's record are what it covers. */
  through: number;
  /** turnsHash of those turns when it was taken. */
  hash: string;
  /** What made it: `clikcode` (ClikCode's own agent) or a vendor command. */
  source: string;
  at: string;
}

/** The thread a conversation had on a provider before it moved on: where a
 * summary that provider wrote can still be read. */
export interface PreviousNativeThread {
  harness: string;
  id: string;
  /** The account whose profile holds it. */
  accountId?: string;
  workspace?: string;
}

export function turnsHash(turns: readonly CanonicalTurn[], through: number): string {
  const hash = createHash('sha256');
  for (const turn of turns.slice(0, through)) hash.update(turn.user).update('\0').update(turn.assistant).update('\u0001');
  return hash.digest('hex').slice(0, 32);
}

/** `summary` if it still describes `record`'s opening turns. */
export function validSummary(summary: ConversationSummary | undefined, record: CanonicalRecord): ConversationSummary | undefined {
  if (!summary?.text.trim() || summary.through < 1 || summary.through > record.turns.length) return undefined;
  return turnsHash(record.turns, summary.through) === summary.hash ? summary : undefined;
}

/** A summary a thread holds, and the requests it kept after it. */
interface ThreadCompaction { text: string; prompts: string[] }

const CLAUDE_PREAMBLE = /^This session is being continued from a previous conversation[^\n]*\n(?:[^\n]*\n)*?\s*Summary:\s*\n/;
/** Claude Code's closing instructions to itself, after the summary proper. */
const CLAUDE_TAILS = [
  '\n\nIf you need specific details from before compaction',
  '\n\nPlease continue the conversation from where',
  '\n\nContinue the conversation from where it left off',
];

export function claudeSummaryText(content: string): string {
  let text = content.replace(CLAUDE_PREAMBLE, '');
  for (const tail of CLAUDE_TAILS) {
    const at = text.indexOf(tail);
    if (at > 0) text = text.slice(0, at);
  }
  return text.trim();
}

function jsonLines(text: string): Record<string, unknown>[] {
  return text.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try { const value = JSON.parse(line) as unknown; return value && typeof value === 'object' ? [value as Record<string, unknown>] : []; } catch { return []; }
  });
}

const blockText = (content: unknown, kind = 'type', field = 'text'): string => (
  typeof content === 'string' ? content
    : Array.isArray(content) ? content.flatMap((block) => {
      const entry = block as Record<string, unknown> | undefined;
      return entry?.[kind] === 'text' && typeof entry[field] === 'string' ? [entry[field] as string] : [];
    }).join('\n') : '');

/** Grok Build rewrites `chat_history.jsonl` when it compacts: the summary is a
 * user row it marks `compaction_meta`, in Claude Code's words; every other
 * unmarked user row left in the file is a request it kept. */
export function grokThreadCompaction(jsonl: string): ThreadCompaction | undefined {
  let text: string | undefined;
  const prompts: string[] = [];
  for (const row of jsonLines(jsonl)) {
    if (row.type !== 'user') continue;
    const content = blockText(row.content);
    if (row.synthetic_reason === 'compaction_meta') {
      if (CLAUDE_PREAMBLE.test(content)) text = claudeSummaryText(content) || text;
    } else if (row.synthetic_reason === undefined && content.trim()) {
      prompts.push(content.replace(/^\s*<user_query>\s*/, '').replace(/\s*<\/user_query>\s*$/, ''));
    }
  }
  return text ? { text, prompts } : undefined;
}

/** Kiro (ACP) appends a `Compaction` entry holding the summary; its requests
 * are the `Prompt` entries after it. */
export function kiroThreadCompaction(jsonl: string): ThreadCompaction | undefined {
  let found: ThreadCompaction | undefined;
  for (const row of jsonLines(jsonl)) {
    const data = row.data as Record<string, unknown> | undefined;
    if (row.kind === 'Compaction' && typeof data?.summary === 'string' && data.summary.trim()) found = { text: data.summary.trim(), prompts: [] };
    else if (found && row.kind === 'Prompt') {
      const content = blockText(data?.content, 'kind', 'data');
      if (content.trim()) found.prompts.push(content);
    }
  }
  return found;
}

/** Copilot CLI appends `session.compaction_complete` with `summaryContent`;
 * its requests are the `user.message` events after it. */
export function copilotThreadCompaction(jsonl: string): ThreadCompaction | undefined {
  let found: ThreadCompaction | undefined;
  for (const row of jsonLines(jsonl)) {
    const data = row.data as Record<string, unknown> | undefined;
    if (row.type === 'session.compaction_complete' && data?.success !== false && typeof data?.summaryContent === 'string' && data.summaryContent.trim()) {
      found = { text: data.summaryContent.trim(), prompts: [] };
    } else if (found && row.type === 'user.message' && typeof data?.content === 'string' && data.content.trim()) {
      found.prompts.push(data.content);
    }
  }
  return found;
}

/** Vendors whose compaction ClikCode can read from their own thread, and how. */
const THREAD_READERS: Record<string, { read: (text: string) => ThreadCompaction | undefined; file?: string }> = {
  grok: { read: grokThreadCompaction, file: 'chat_history.jsonl' },
  kiro: { read: kiroThreadCompaction },
  copilot: { read: copilotThreadCompaction, file: 'events.jsonl' },
};

/** Claude Code's compaction is readable text too (its own words, claudeSummaryText). */
export function readsVendorCompaction(command: string): boolean {
  return command === 'claude' || command in THREAD_READERS;
}

/** "first 12 turns summarized": what a list row or a heading says. */
export function summaryHeadline(summary: Pick<ConversationSummary, 'through'>): string {
  return `first ${summary.through} turn${summary.through === 1 ? '' : 's'} summarized`;
}

/** The summary still standing for `session`'s opening turns, for /history
 * and /export: the transcript must be loaded, and one a redo or an edit has
 * since retired (its hash) is not shown. */
export function shownSummary(session: HarnessSession): ConversationSummary | undefined {
  return session.summary ? validSummary(session.summary, canonicalRecord(session)) : undefined;
}

/** For a row drawn from the index, with no transcript to check the hash
 * against: shown while the conversation still has at least that many
 * messages, so a conversation cut back below it says nothing. */
export function listedSummary(session: Pick<HarnessSession, 'summary' | 'listMessageCount'>): ConversationSummary | undefined {
  const summary = session.summary;
  if (!summary?.text.trim() || summary.through < 1) return undefined;
  return session.listMessageCount === undefined || summary.through <= session.listMessageCount ? summary : undefined;
}
