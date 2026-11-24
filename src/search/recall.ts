/** Automatic recall: before a request goes to the model, the messages of this conversation that the
 * model's context no longer holds (turn/compaction.ts recallBoundary) are searched with the request,
 * and the few that clearly match it ride along AFTER the user's words -- what the vendor has cached of
 * the thread is untouched. Most requests attach nothing.
 *
 * A match must stand out, or nothing is attached:
 * - by its words: an identifier, path or quoted phrase of the request that only a few messages before
 *   the boundary have, and none the context still holds;
 * - by meaning: the conversation search's own gate (vectors.ts semanticMatches: a floor, and a clear
 *   lift over the conversation's median message).
 *
 * Never fails or holds up a turn: the whole search runs within RECALL_BUDGET_MS, waits for the embedder
 * only for what is left of it, and is lexical alone (or nothing) without one. */
import { conversationGroups, findConversation } from './conversations.js';
import { conversationView, indexOfWord, type ConversationView, type MessageDoc } from './corpus.js';
import { isContinuation } from './hindsight.js';
import { queryVector } from './hybrid.js';
import { semanticMatches, type SemanticMatch } from './vectors.js';
import { lifecycle } from '../runtime/lifecycle-log.js';
import { wrapRecallNote } from '../turn/resource-note-text.js';

export const RECALL_BUDGET_MS = 1200;
/** At most this many messages, in at most this many characters (about 1.5k tokens). */
export const RECALL_MAX_MESSAGES = 3;
export const RECALL_MAX_CHARS = 6000;
/** A request shorter than this says too little to search with. */
const MIN_QUERY_CHARS = 12;
/** A word of the request found in more messages than this is no evidence of one place. */
const MAX_WORD_HITS = 3;
/** The embedder is waited for at most this long, within the budget. */
const MAX_EMBED_WAIT_MS = 600;

/** Knobs the compaction eval (scripts/compaction-eval.mjs) varies, read per call; unset, each is the
 * shipped value above. Never set outside the eval. */
const evalKnob = (name: string, fallback: number): number => {
  const value = Number(process.env[`CLIKCODE_EVAL_RECALL_${name}`]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export interface RecallHit { position: number; score: number; by: 'words' | 'meaning'; at: number; length?: number }

export interface RecallOutcome {
  /** The note to append, or undefined when nothing stood out. */
  note?: string;
  hits: RecallHit[];
  /** Why nothing was searched. */
  skipped?: 'no-boundary' | 'short' | 'continuation' | 'no-conversation' | 'timeout';
}

/** Words the eval's PLAIN mode never takes: its probe frame, and question words. */
const EVAL_STOP = new Set(['sentences', 'exact', 'names', 'values', 'question', 'what', 'which', 'when', 'where', 'whom', 'with', 'that', 'this', 'from', 'about', 'into', 'their', 'there', 'they', 'were', 'have', 'does', 'did', 'why', 'how', 'user', 'assistant', 'conversation']);

/** Identifiers, paths, numbers with letters, and quoted phrases of a request: what can only match a
 * place in the conversation by being the same thing. Lower-cased. */
export function distinctiveWords(query: string): string[] {
  const words = new Set<string>();
  // Eval: PLAIN=1 takes every word of 4+ letters; lexicalHits' MAX_WORD_HITS cap keeps only the rare ones.
  if (process.env.CLIKCODE_EVAL_RECALL_PLAIN === '1') for (const match of query.matchAll(/[A-Za-z0-9_][A-Za-z0-9_./:#@-]*[A-Za-z0-9_]/g)) if (match[0].length >= 4 && !EVAL_STOP.has(match[0].toLowerCase())) words.add(match[0].toLowerCase());
  for (const match of query.matchAll(/["`']([^"`'\n]{4,80})["`']/g)) words.add(match[1]!.trim().toLowerCase());
  for (const match of query.matchAll(/[A-Za-z0-9_][A-Za-z0-9_./:#@-]*[A-Za-z0-9_]/g)) {
    const word = match[0];
    if (word.length < 4) continue;
    const marked = /[0-9_./:#@-]/.test(word) && /[A-Za-z]/.test(word) || /[a-z][A-Z]/.test(word) || /^[0-9a-f]{7,40}$/i.test(word);
    if (marked) words.add(word.toLowerCase());
  }
  return [...words];
}

/** Matches by words: each distinctive word of the request found in at most MAX_WORD_HITS messages
 * before the boundary and in none after it. A message scores the words it has. */
export function lexicalHits(view: ConversationView, outside: readonly number[], inside: readonly number[], words: readonly string[], maxWordHits = MAX_WORD_HITS): RecallHit[] {
  const scores = new Map<number, RecallHit>();
  for (const word of words) {
    if (inside.some((position) => indexOfWord(view.entries[position]!.message.text, word) >= 0)) continue;
    const found: Array<{ position: number; at: number }> = [];
    for (const position of outside) {
      const at = indexOfWord(view.entries[position]!.message.text, word);
      if (at >= 0) found.push({ position, at });
      if (found.length > maxWordHits) break;
    }
    if (!found.length || found.length > maxWordHits) continue;
    for (const { position, at } of found) {
      const prior = scores.get(position);
      if (prior) prior.score += 1;
      else scores.set(position, { position, score: 1, by: 'words', at });
    }
  }
  return [...scores.values()].sort((left, right) => right.score - left.score || right.position - left.position);
}

function excerpt(message: MessageDoc, at: number, length: number | undefined, room: number): string {
  const text = message.text;
  const span = Math.min(room, Math.max(length ?? 0, 400));
  const start = Math.max(0, Math.min(at - Math.floor((span - (length ?? 0)) / 2), text.length - span));
  const body = text.slice(start, start + span).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${body}${start + span < text.length ? '…' : ''}`;
}

/** Eval-only (CLIKCODE_EVAL_RECALL_NUDGE=1): a model given these excerpts tends to answer from them alone, and they are
 * matched lines, not the whole messages. Said here, beside the request, rather than only in the summary's note. */
const RECALL_NUDGE = 'These are matched excerpts and may leave out what the request needs. When they do not settle it (a value, a commit, a reason), read the message with hindsight(at=<number>) or search hindsight query=<other words> before answering; do not answer from memory or say it is not recorded without that.';

/** The note for `hits`: each message's number, who said it, and the part that matched. */
export function recallNote(view: ConversationView, hits: readonly RecallHit[], hasHindsight: boolean, maxChars = RECALL_MAX_CHARS): string {
  const room = Math.floor(maxChars / Math.max(1, hits.length));
  const lines = [...hits].sort((left, right) => left.position - right.position).map((hit) => {
    const message = view.entries[hit.position]!.message;
    const where = hit.at >= message.contentLength ? `${message.role} (tool call)` : message.role;
    return `#${hit.position} ${where}: ${excerpt(message, hit.at, hit.length, room)}`;
  });
  const reach = hasHindsight ? ' hindsight(at=<number>) reads one whole.' : '';
  return wrapRecallNote([
    `From earlier in this conversation, before what your context now holds; matched to this request by ClikCode, not written by the user.${reach}`,
    ...lines,
    ...hasHindsight && process.env.CLIKCODE_EVAL_RECALL_NUDGE === '1' ? [RECALL_NUDGE] : [],
  ].join('\n'));
}

/** The meaning gate's defaults: no standout lift, rare-word re-rank at this weight. */
const GATE_LIFT = 0;
const GATE_TERM_WEIGHT = 0.3;

/** `matches` re-scored by cosine + weight x (idf share of the request's words in the chunk). */
function termRanked(view: ConversationView, outside: readonly number[], matches: SemanticMatch[], query: string, weight: number): SemanticMatch[] {
  const terms = [...new Set((query.toLowerCase().match(/[a-z0-9_][a-z0-9_./:#@-]*[a-z0-9_]/g) ?? []).filter((word) => word.length >= 4 && !EVAL_STOP.has(word)))];
  if (!terms.length) return matches;
  const texts = outside.map((position) => view.entries[position]!.message.text.toLowerCase());
  const idf = terms.map((term) => Math.log((texts.length + 1) / (1 + texts.filter((text) => text.includes(term)).length)));
  const total = idf.reduce((sum, value) => sum + value, 0) || 1;
  return matches.map((match) => {
    const chunk = view.entries[match.position]!.message.text.slice(match.offset, match.offset + match.length).toLowerCase();
    const share = terms.reduce((sum, term, index) => sum + (chunk.includes(term) ? idf[index]! : 0), 0) / total;
    return { ...match, score: match.score + weight * share };
  }).sort((left, right) => right.score - left.score);
}

async function search(sessionId: string, query: string, boundary: number, hasHindsight: boolean, deadline: number, context?: string): Promise<RecallOutcome> {
  const found = findConversation(await conversationGroups(), sessionId);
  if (!found) return { hits: [], skipped: 'no-conversation' };
  const view = await conversationView(found.group);
  const own = view.positions.get(found.branch?.id ?? sessionId) ?? view.positions.get(sessionId) ?? [];
  const cut = Math.min(boundary, own.length);
  const outside = own.slice(0, cut);
  const inside = own.slice(cut);
  if (!outside.length) return { hits: [], skipped: 'no-boundary' };
  const maxMessages = evalKnob('MAX', RECALL_MAX_MESSAGES);
  // Eval: QUERY=context adds the last assistant turn to both searches, context-meaning to the meaning one only.
  const queryMode = process.env.CLIKCODE_EVAL_RECALL_QUERY;
  const withContext = context && queryMode ? `${context.slice(-1500)}\n\n${query}` : query;
  const lexical = lexicalHits(view, outside, inside, distinctiveWords(queryMode === 'context' ? withContext : query), evalKnob('WORD_HITS', MAX_WORD_HITS));
  const meaningFirst = process.env.CLIKCODE_EVAL_RECALL_ORDER === 'meaning';
  const hits = meaningFirst ? [] : lexical.slice(0, maxMessages);
  const wait = Math.min(evalKnob('EMBED_WAIT', MAX_EMBED_WAIT_MS), deadline - Date.now());
  if (hits.length < maxMessages && wait > 0) {
    const vector = await queryVector(withContext, wait);
    if (vector) {
      const allowed = new Set(outside);
      const taken = new Set(hits.map((hit) => hit.position));
      const min = Number(process.env.CLIKCODE_EVAL_RECALL_MIN) || undefined;
      // Top-k by meaning above the floor (no standout lift), re-ranked by the share of the request's
      // rare words (by inverse message frequency) in the chunk: the compaction eval's floor run.
      // CLIKCODE_EVAL_GATE_LIFT / CLIKCODE_EVAL_GATE_TERMS override them (TERMS=0 turns the re-rank off).
      const liftKnob = process.env.CLIKCODE_EVAL_GATE_LIFT;
      const lift = liftKnob !== undefined && liftKnob !== '' && Number.isFinite(Number(liftKnob)) ? Number(liftKnob) : GATE_LIFT;
      const termsKnob = process.env.CLIKCODE_EVAL_GATE_TERMS;
      const termWeight = termsKnob !== undefined && termsKnob !== '' && Number.isFinite(Number(termsKnob)) ? Number(termsKnob) : GATE_TERM_WEIGHT;
      let matches = await semanticMatches(found.group, view, vector.vector, vector.embedderId, { limit: termWeight ? 400 : 20, ...(min ? { min } : {}), lift });
      if (termWeight) matches = termRanked(view, outside, matches, query, termWeight).slice(0, 20);
      for (const match of matches) {
        if (hits.length >= maxMessages) break;
        if (!allowed.has(match.position) || taken.has(match.position)) continue;
        hits.push({ position: match.position, score: Math.round(match.score * 1000) / 1000, by: 'meaning', at: match.offset, length: match.length });
        taken.add(match.position);
      }
    }
  }
  if (meaningFirst) {
    const taken = new Set(hits.map((hit) => hit.position));
    for (const hit of lexical) { if (hits.length >= maxMessages) break; if (!taken.has(hit.position)) hits.push(hit); }
  }
  return hits.length ? { hits, note: recallNote(view, hits, hasHindsight, evalKnob('CHARS', RECALL_MAX_CHARS)) } : { hits };
}

/** `turnText` with what recall found appended, or as it is. `boundary`: how many of the chat's first
 * messages the context holds only as a summary or not at all (recallBoundary). Never throws. */
export async function withRecall(
  input: { sessionId: string; query: string; boundary: number; hasHindsight: boolean; budgetMs?: number; context?: string }, turnText: string,
): Promise<string> {
  const outcome = await recall(input);
  return outcome.note ? `${turnText}\n\n${outcome.note}` : turnText;
}

/** What recall finds for this request, within the budget. Never throws. */
export async function recall(input: { sessionId: string; query: string; boundary: number; hasHindsight: boolean; budgetMs?: number; context?: string }): Promise<RecallOutcome> {
  const started = Date.now();
  const query = input.query.trim();
  let outcome: RecallOutcome;
  if (input.boundary <= 0) outcome = { hits: [], skipped: 'no-boundary' };
  else if (query.length < MIN_QUERY_CHARS) outcome = { hits: [], skipped: 'short' };
  else if (isContinuation(query)) outcome = { hits: [], skipped: 'continuation' };
  else {
    const budget = input.budgetMs ?? evalKnob('BUDGET', RECALL_BUDGET_MS);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<RecallOutcome>((resolve) => { timer = setTimeout(() => resolve({ hits: [], skipped: 'timeout' }), budget); });
    const work = search(input.sessionId, query, input.boundary, input.hasHindsight, started + budget, input.context)
      .catch((error: unknown): RecallOutcome => {
        lifecycle('turn.recall.error', { message: error instanceof Error ? error.message : String(error) });
        return { hits: [] };
      });
    outcome = await Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  }
  if (outcome.skipped !== 'no-boundary') {
    lifecycle('turn.recall', {
      boundary: input.boundary, ms: Date.now() - started, attached: outcome.hits.length, chars: outcome.note?.length ?? 0,
      ...(outcome.skipped ? { skipped: outcome.skipped } : {}),
      ...(outcome.hits.length ? { hits: outcome.hits.map((hit) => `${hit.position}:${hit.by}:${hit.score}`).join(',') } : {}),
    });
  }
  return outcome;
}

/** For ClikCode's own agent, which keeps every turn in its memory and reads the newest part that fits
 * its budget (agent/context-view.ts stableTail): how many of the transcript's first messages are
 * outside that part. The memory's size against the transcript's scales each message. 0 when it fits. */
export function agentRecallBoundary(messages: ReadonlyArray<{ content?: string }>, memoryBytes: number, budgetTokens: number | undefined, bytesPerToken: number): number {
  if (!budgetTokens || budgetTokens <= 0 || memoryBytes <= budgetTokens * bytesPerToken) return 0;
  const sizes = messages.map((message) => Buffer.byteLength(message.content ?? '', 'utf8') + 16);
  const transcriptBytes = sizes.reduce((sum, size) => sum + size, 0);
  if (!transcriptBytes) return 0;
  const scale = memoryBytes / transcriptBytes;
  let used = 0;
  for (let index = sizes.length - 1; index >= 0; index -= 1) {
    used += sizes[index]! * scale;
    if (used > budgetTokens * bytesPerToken) return index + 1;
  }
  return 0;
}
