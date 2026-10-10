/** A conversation's summary, carried to whichever provider takes it next.
 *
 * When a harness compacts a conversation -- ClikCode's own agent, or a vendor
 * whose summary is readable text (Claude Code) -- the summary is the
 * conversation's: the next provider gets it the way it would have made it
 * itself, not a retelling of the turns it covers, and nothing is summarized
 * twice. A summary is bound to the exact turns it covers (`hash`): a redo,
 * fork or edit that changes any of them retires it on its own.
 *
 * Codex's compactions are encrypted for OpenAI's own servers
 * (`encrypted_content`, an empty `message`): only Codex can read them, so
 * there is nothing here to carry. */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CanonicalRecord, CanonicalTurn } from './canonical.js';
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

const normal = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Whether a prompt a thread kept is the request a turn records. A vendor
 * thread holds the request as it was sent: after a provider note, with the
 * title instruction or the attached files appended. */
function sameRequest(turn: CanonicalTurn, prompt: string): boolean {
  const request = normal(turn.user);
  if (!request) return false;
  const kept = normal(prompt);
  return kept.includes(request.slice(0, 160)) || request.includes(kept.slice(0, 160));
}

/** Where `prompts` -- the requests a thread kept after its summary, in order --
 * begin among `turns`: the latest turn from which every one of them (as many
 * as there are turns left) is matched in order. Undefined when they cannot be
 * placed: a summary whose end is not known is not used. */
export function alignPrompts(turns: readonly CanonicalTurn[], prompts: readonly string[]): number | undefined {
  const wanted = prompts.filter((prompt) => normal(prompt)).slice(0, 4);
  // "yes", "continue", "check": requests that short recur, and would place a
  // summary on the wrong turn. Too little to go on is no placement.
  if (wanted.reduce((sum, prompt) => sum + normal(prompt).length, 0) < 24) return undefined;
  for (let start = turns.length - 1; start >= 0; start -= 1) {
    const span = Math.min(wanted.length, turns.length - start);
    let ok = true;
    for (let offset = 0; offset < span && ok; offset += 1) ok = sameRequest(turns[start + offset]!, wanted[offset]!);
    if (ok) return start;
  }
  return undefined;
}

/** A summary a thread holds, and the requests it kept after it. */
export interface ThreadCompaction { text: string; prompts: string[] }

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

function claudeText(message: unknown): string | undefined {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  if (content.some((block) => (block as { type?: string })?.type === 'tool_result')) return undefined;
  const text = content.flatMap((block) => ((block as { type?: string })?.type === 'text' && typeof (block as { text?: unknown }).text === 'string' ? [(block as { text: string }).text] : [])).join('\n');
  return text || undefined;
}

/** The newest compaction in a Claude Code session transcript (JSONL): its
 * summary (the `isCompactSummary` user message) and the requests after it. */
export function claudeThreadCompaction(jsonl: string): ThreadCompaction | undefined {
  let found: ThreadCompaction | undefined;
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"type":"user"')) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (entry.type !== 'user' || entry.isSidechain === true) continue;
    const text = claudeText(entry.message);
    if (!text) continue;
    if (entry.isCompactSummary === true) {
      const summary = claudeSummaryText(text);
      found = summary ? { text: summary, prompts: [] } : found;
      continue;
    }
    if (!found || entry.isMeta === true || entry.isVisibleInTranscriptOnly === true) continue;
    found.prompts.push(text);
  }
  return found;
}

/** The newest compaction in ClikCode's own agent memory (`harness.jsonl`): its
 * summary and the requests it kept. Notes ClikCode adds to the agent's memory
 * (`<environment>`, `[ClikCode] …`) are not requests. */
export function agentMemoryCompaction(jsonl: string): ThreadCompaction | undefined {
  let found: ThreadCompaction | undefined;
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"kind":"compaction"') && !(found && line.includes('"role":"user"'))) continue;
    let entry: { kind?: string; summary?: unknown; keep?: unknown; item?: { type?: string; role?: string; text?: unknown } };
    try { entry = JSON.parse(line) as typeof entry; } catch { continue; }
    const request = (item: typeof entry.item): string | undefined => (
      item?.type === 'text' && item.role === 'user' && typeof item.text === 'string' && !/^\s*(<environment>|\[ClikCode\])/.test(item.text) ? item.text : undefined);
    if (entry.kind === 'compaction' && typeof entry.summary === 'string' && entry.summary.trim()) {
      const keep = Array.isArray(entry.keep) ? entry.keep as typeof entry.item[] : [];
      found = { text: entry.summary.trim(), prompts: keep.flatMap((item) => request(item) ?? []) };
    } else if (found && entry.kind === 'item') {
      const text = request(entry.item);
      if (text) found.prompts.push(text);
    }
  }
  return found;
}

/** A compaction placed in the conversation: it covers the turns before the
 * first request it kept. A compaction with no request after it covers all
 * but the newest turn, which is kept as it stands. A vendor that compacted in
 * the middle of a turn keeps that turn's request on its far side of the
 * summary, so the turn before the first kept request is kept too: its answer
 * may have gone on after the summary was taken. */
export function placeCompaction(compaction: ThreadCompaction, record: CanonicalRecord, source: string, now = new Date()): ConversationSummary | undefined {
  const turns = record.turns;
  if (turns.length < 2) return undefined;
  const start = compaction.prompts.length ? alignPrompts(turns, compaction.prompts) : turns.length - 1;
  if (start === undefined) return undefined;
  const through = source === 'clikcode' ? start : start - 1;
  if (through < 1) return undefined;
  return { text: compaction.text, through, hash: turnsHash(turns, through), source, at: now.toISOString() };
}

async function readText(file: string): Promise<string | undefined> {
  try { return await fs.readFile(file, 'utf8'); } catch { return undefined; }
}

export interface SummarySources {
  /** ClikCode's state directory (the agent's memory lives under it). */
  stateDir: string;
  /** A vendor thread's transcript file, when its store can find it. */
  threadFile?: (thread: PreviousNativeThread) => Promise<string | undefined>;
}

/** Vendors whose compaction ClikCode can read from their own thread, and how. */
const THREAD_READERS: Record<string, (text: string) => ThreadCompaction | undefined> = {
  claude: claudeThreadCompaction,
};

export function readsVendorCompaction(command: string): boolean {
  return command in THREAD_READERS;
}

/** The conversation's best summary: the one covering the most turns, from
 * what was kept before, ClikCode's own agent memory, and the vendor threads
 * the conversation has had. Kept on `session.summary` for the next hand-over. */
export async function conversationSummary(session: HarnessSession, record: CanonicalRecord, sources: SummarySources): Promise<ConversationSummary | undefined> {
  const candidates: (ConversationSummary | undefined)[] = [validSummary(session.summary, record)];
  const memory = await readText(path.join(sources.stateDir, 'sessions', session.id, 'harness.jsonl'));
  const own = memory ? agentMemoryCompaction(memory) : undefined;
  if (own) candidates.push(placeCompaction(own, record, 'clikcode'));
  const threads: PreviousNativeThread[] = [];
  if (session.nativeHarness && session.nativeSessionId) {
    const accountId = session.nativeThreadAccountId ?? session.accountId ?? undefined;
    threads.push({ harness: session.nativeHarness, id: session.nativeSessionId, ...(accountId ? { accountId } : {}), ...(session.workspace ? { workspace: session.workspace } : {}) });
  }
  if (session.previousNativeThread) threads.push(session.previousNativeThread);
  for (const thread of threads) {
    const reader = THREAD_READERS[thread.harness];
    if (!reader || !sources.threadFile) continue;
    const file = await sources.threadFile(thread).catch(() => undefined);
    const text = file ? await readText(file) : undefined;
    const compaction = text ? reader(text) : undefined;
    if (compaction) candidates.push(placeCompaction(compaction, record, thread.harness));
  }
  const best = candidates.reduce<ConversationSummary | undefined>((winner, next) => (next && (!winner || next.through > winner.through) ? next : winner), undefined);
  if (best && best !== session.summary) session.summary = best;
  return best;
}

/** `record` with `summary` in place of the turns it covers. The newest turn is
 * always kept as it stands: the next provider continues from it. */
export function summarizedRecord(record: CanonicalRecord, summary: ConversationSummary | undefined): CanonicalRecord {
  const valid = validSummary(summary, record);
  if (!valid) return record;
  const through = Math.min(valid.through, record.turns.length - 1);
  if (through < 1) return record;
  return { ...record, turns: record.turns.slice(through), summary: { text: valid.text, through, source: valid.source } };
}

/** The summary as a note opening the first kept request, for a provider with
 * no compaction of its own to write it into. */
export function summaryNote(summary: NonNullable<CanonicalRecord['summary']>): string {
  return `[ClikCode: the conversation's first ${summary.through} turn${summary.through === 1 ? ' is' : 's are'} summarized below.]\n\n<summary>\n${summary.text}\n</summary>`;
}
