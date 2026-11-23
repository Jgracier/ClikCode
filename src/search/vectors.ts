/** Per-conversation vectors for semantic search: one file beside the
 * conversation's other files, `sessions/<conversation id>/vectors.jsonl`.
 * No database, no server: a search reads the file and compares every vector
 * (brute force; a long conversation is a few thousand).
 *
 * A message (corpus.ts MessageDoc: its words, then a line per tool call) is
 * cut into chunks (chunkMessage). Each chunk is keyed by the message's
 * fingerprint and where the chunk starts, so a record stays right however
 * the conversation is numbered later: an edited or compacted message has a
 * new fingerprint and is embedded again, a branch that shares history shares
 * its records, and a record whose fingerprint no message has any more is
 * ignored. Indexing only embeds keys the file does not have, appends them in
 * small batches, and one process at a time does it per conversation.
 *
 * The first line names the embedder; a file from another is started over.
 * Each record keeps what a later reader filters by: conversation, chat,
 * message number, when, workspace, harness, provider and model. No text is
 * stored: the transcript is the text. Vectors are int8 with a scale. */

import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionsDirectory, safeRecordFileName } from '../session/store/paths.js';
import { tryLease } from '../session/store/locks.js';
import type { ConversationGroup } from './conversations.js';
import { conversationView, type ConversationView, type MessageDoc } from './corpus.js';
import type { Embedder } from './embedder.js';
import { quiet } from '../runtime/lifecycle-log.js';

export const CHUNK_CHARS = 1000;
export const CHUNK_OVERLAP = 150;
/** Of a tool call's output, what is embedded: the label says what it was, and the rest is lexical search's. */
const TOOL_OUTPUT_CHARS = 360;
/** Less than this many letters or digits says too little to place ("ok", "go on"). */
const MIN_SIGNAL = 12;
/** Chunks per append: one small write per embedding request. */
const WRITE_BATCH = 16;

export interface Chunk {
  /** Into the message's searchable text: where a hit points. */
  offset: number;
  length: number;
  /** What is embedded. */
  text: string;
}

const signal = (text: string): number => (text.match(/[\p{L}\p{N}]/gu) ?? []).length;

/** Windows of at most `size`, overlapping by `overlap`, ended at a space where one is near. */
function windows(text: string, base: number, size: number, overlap: number): Chunk[] {
  const out: Chunk[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const space = text.lastIndexOf(' ', end);
      if (space > start + size * 0.6) end = space;
    }
    out.push({ offset: base + start, length: end - start, text: text.slice(start, end) });
    if (end >= text.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return out;
}

/** A message as the chunks it is embedded in: its words in overlapping
 * windows, then its tool calls (label and the start of the output), several
 * to a chunk. */
export function chunkMessage(message: Pick<MessageDoc, 'text' | 'contentLength'>): Chunk[] {
  const content = message.text.slice(0, message.contentLength);
  const chunks = windows(content, 0, CHUNK_CHARS, CHUNK_OVERLAP);
  const calls = message.text.slice(message.contentLength);
  // Each call starts "\n  ⏺ " (corpus.ts activityText).
  const starts: number[] = [];
  for (let at = calls.indexOf('  ⏺ '); at >= 0; at = calls.indexOf('\n  ⏺ ', at + 1)) starts.push(calls[at] === '\n' ? at + 1 : at);
  let group: Chunk | undefined;
  for (const [index, start] of starts.entries()) {
    const end = starts[index + 1] ?? calls.length;
    const block = calls.slice(start, end).trimEnd();
    const lineEnd = block.indexOf('\n');
    const piece = lineEnd < 0 ? block : block.slice(0, Math.min(block.length, lineEnd + TOOL_OUTPUT_CHARS));
    const offset = message.contentLength + start;
    if (group && group.text.length + 1 + piece.length <= CHUNK_CHARS) {
      group.text += `\n${piece}`;
      group.length = offset + block.length - group.offset;
    } else {
      if (group) chunks.push(group);
      group = { offset, length: block.length, text: piece.slice(0, CHUNK_CHARS) };
    }
  }
  if (group) chunks.push(group);
  return chunks.filter((chunk) => signal(chunk.text) >= MIN_SIGNAL);
}

/** One stored chunk. */
export interface VectorRecord {
  /** The message's fingerprint (corpus.ts) and where in its text the chunk is. */
  fingerprint: string;
  offset: number;
  length: number;
  conversation: string;
  /** The chat it was read from, and its index there. */
  session: string;
  index: number;
  /** Its number in the conversation when indexed (the merged numbering agents see). */
  message: number;
  role: 'user' | 'assistant';
  /** No later than this: when it was indexed, or for older messages the conversation's last activity. */
  at: string;
  workspace?: string;
  harness?: string;
  provider?: string;
  model?: string;
  /** int8, base64, times scale. */
  scale: number;
  vector: string;
}

interface Header { embedder: string; dims: number }

export function vectorFilePath(conversationId: string): string {
  return join(sessionsDirectory(), safeRecordFileName(conversationId), 'vectors.jsonl');
}

export function quantize(vector: Float32Array): { scale: number; vector: string } {
  let max = 0;
  for (const value of vector) max = Math.max(max, Math.abs(value));
  const scale = max / 127 || 1;
  const bytes = Int8Array.from(vector, (value) => Math.round(value / scale));
  return { scale, vector: Buffer.from(bytes.buffer).toString('base64') };
}

function unit(record: Pick<VectorRecord, 'scale' | 'vector'>): Float32Array {
  const bytes = Buffer.from(record.vector, 'base64');
  const values = new Float32Array(bytes.length);
  let norm = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const value = (bytes[index]! << 24 >> 24) * record.scale;
    values[index] = value;
    norm += value * value;
  }
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < values.length; index += 1) values[index] = values[index]! / norm;
  return values;
}

export function cosine(left: Float32Array, right: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) sum += left[index]! * right[index]!;
  return sum;
}

interface Loaded { key: string; embedder?: string; records: Map<string, VectorRecord & { unit?: Float32Array }> }
/** By file, while its size and time are what they were. */
const loaded = new Map<string, Loaded>();
const MAX_LOADED = 256;

const recordKey = (fingerprint: string, offset: number): string => `${fingerprint}@${offset}`;

async function load(file: string): Promise<Loaded> {
  const info = await stat(file).catch(quiet('search/vectors'));
  const key = info ? `${info.size}:${info.mtimeMs}` : 'none';
  const cached = loaded.get(file);
  if (cached?.key === key) return cached;
  const result: Loaded = { key, records: new Map() };
  if (info) {
    const text = await readFile(file, 'utf8').catch(() => '');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; } // A torn last line from a write cut short.
      if (result.embedder === undefined) {
        const header = parsed as Partial<Header>;
        if (typeof header.embedder !== 'string') break;
        result.embedder = header.embedder;
        continue;
      }
      const record = parsed as VectorRecord;
      if (typeof record.fingerprint === 'string' && typeof record.vector === 'string') result.records.set(recordKey(record.fingerprint, record.offset), record);
    }
  }
  loaded.delete(file);
  loaded.set(file, result);
  for (const [oldest] of loaded) { if (loaded.size <= MAX_LOADED) break; loaded.delete(oldest); }
  return result;
}

export function resetVectorCache(): void { loaded.clear(); }

/** What indexing did: chunks embedded now, and whether any are left. */
export interface IndexResult { embedded: number; pending: number; skipped?: 'busy' | 'failed' }

/** Embed what this conversation's file lacks, newest messages first, until
 * `deadline` (ms since epoch). Never re-embeds a key the file has. */
export async function indexConversation(group: ConversationGroup, embedder: Embedder, options: { deadline?: number; now?: number; view?: ConversationView } = {}): Promise<IndexResult> {
  const view = options.view ?? await conversationView(group);
  const file = vectorFilePath(group.id);
  const missing = (have: Loaded): Array<{ position: number; chunk: Chunk; message: MessageDoc }> => {
    const out: Array<{ position: number; chunk: Chunk; message: MessageDoc }> = [];
    const seen = new Set<string>();
    for (let position = view.entries.length - 1; position >= 0; position -= 1) {
      const message = view.entries[position]!.message;
      if (seen.has(message.fingerprint)) continue;
      seen.add(message.fingerprint);
      for (const chunk of chunkMessage(message)) {
        if (!have.records.has(recordKey(message.fingerprint, chunk.offset))) out.push({ position, chunk, message });
      }
    }
    return out;
  };
  const before = await load(file);
  if (before.embedder === embedder.id && !missing(before).length) return { embedded: 0, pending: 0 };
  await mkdir(join(file, '..'), { recursive: true });
  const lease = await tryLease(`${file}.lock`);
  if (!lease) return { embedded: 0, pending: missing(before).length, skipped: 'busy' };
  try {
    let have = await load(file);
    if (have.embedder !== embedder.id) {
      await writeFile(file, `${JSON.stringify({ embedder: embedder.id, dims: embedder.dims } satisfies Header)}\n`);
      have = await load(file);
    }
    const todo = missing(have);
    const sessions = new Map(group.branches.map((branch) => [branch.id, branch]));
    const at = new Date(Math.min(options.now ?? Date.now(), Number.isFinite(group.updatedAtMs) ? group.updatedAtMs : Number.POSITIVE_INFINITY)).toISOString();
    let embedded = 0;
    for (let start = 0; start < todo.length; start += WRITE_BATCH) {
      if (options.deadline !== undefined && Date.now() > options.deadline) break;
      const batch = todo.slice(start, start + WRITE_BATCH);
      let vectors: Float32Array[];
      try { vectors = await embedder.embed(batch.map((item) => item.chunk.text), 'passage'); }
      catch { return { embedded, pending: todo.length - embedded, skipped: 'failed' }; }
      const lines = batch.map((item, index) => {
        const entry = view.entries[item.position]!;
        const chat = sessions.get(entry.sessionId) ?? group.newest;
        const record: VectorRecord = {
          fingerprint: item.message.fingerprint, offset: item.chunk.offset, length: item.chunk.length,
          conversation: group.id, session: entry.sessionId, index: entry.index, message: item.position, role: item.message.role, at,
          ...(chat.workspace ? { workspace: chat.workspace } : {}),
          ...(chat.nativeHarness ? { harness: chat.nativeHarness } : {}),
          ...(chat.provider ? { provider: chat.provider } : {}),
          ...(chat.model ? { model: chat.model } : {}),
          ...quantize(vectors[index]!),
        };
        return JSON.stringify(record);
      });
      if (!(await lease.held())) break;
      await appendFile(file, `${lines.join('\n')}\n`);
      embedded += batch.length;
    }
    return { embedded, pending: todo.length - embedded };
  } finally { await lease.release(); }
}

/** A message that is near the query in meaning: its number, and its best chunk. */
export interface SemanticMatch { position: number; offset: number; length: number; score: number }

/** Below this, bge-small's cosine is no evidence of the same subject. */
export const MIN_SIMILARITY = 0.62;
/** bge-small scores any two texts high, and how high moves with the query:
 * on a real 4,000-message chat, words that mean nothing there (an unknown
 * identifier, "zebra migration") reach 0.65-0.70 at the top, while the right
 * topic for a paraphrase sits at 0.73-0.75. What tells them apart is the lift
 * over the query's median message: 0.22-0.28 for a real match, at most 0.16
 * for noise. So a match must clear the median by LIFT, once a chat has
 * MEDIAN_FROM messages for a median to mean something. */
const LIFT = 0.2;
const MEDIAN_FROM = 32;

/** This conversation's messages nearest `query`, best first, at most one per
 * message (its best chunk), only those still in the conversation as it is. */
export async function semanticMatches(group: Pick<ConversationGroup, 'id'>, view: ConversationView, query: Float32Array, embedderId: string, options: { limit?: number; min?: number } = {}): Promise<SemanticMatch[]> {
  const have = await load(vectorFilePath(group.id));
  if (have.embedder !== embedderId || !have.records.size) return [];
  const positions = new Map<string, number>();
  for (const [position, entry] of view.entries.entries()) if (!positions.has(entry.message.fingerprint)) positions.set(entry.message.fingerprint, position);
  const best = new Map<number, SemanticMatch>();
  for (const record of have.records.values()) {
    const position = positions.get(record.fingerprint);
    if (position === undefined) continue;
    record.unit ??= unit(record);
    if (record.unit.length !== query.length) continue;
    const score = cosine(record.unit, query);
    const prior = best.get(position);
    if (!prior || score > prior.score) best.set(position, { position, offset: record.offset, length: record.length, score });
  }
  const ranked = [...best.values()].sort((left, right) => right.score - left.score);
  const median = ranked.length >= MEDIAN_FROM ? ranked[Math.floor(ranked.length / 2)]!.score : -1;
  const min = Math.max(options.min ?? MIN_SIMILARITY, median + LIFT);
  return ranked.filter((match) => match.score >= min).slice(0, options.limit ?? 20);
}
