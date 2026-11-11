/** Every conversation's saved messages as searchable text, cached per
 * transcript.
 *
 * A message's text is what it says and then, for an assistant message, a
 * compact line per tool call it made (its label and the output it kept), so
 * "the command that printed X" is findable too. Offsets into that text are
 * the anchors search hands out.
 *
 * The cache is keyed on the files a transcript is made of (transcriptIdentity:
 * its log and `<id>.json`, or for a chat still in that older format, that
 * file and each parent a fork reference points into). Never a
 * clock: an unchanged file is never read again, and a changed one is never
 * served stale, however soon after it was written. */

import type { TranscriptMessage } from '../session/model.js';
import type { ConversationGroup } from './conversations.js';
import { sessionFilePath } from '../session/store/paths.js';
import { ConversationLogMissingError, readSessionTranscript, transcriptIdentity } from '../session/store/transcripts.js';
import { readTurnActivities } from '../turn/turn-activities.js';

export interface MessageDoc {
  role: 'user' | 'assistant';
  /** Content, then one block per tool call. Matched case-insensitively
   * (indexOfWord, the query's `i` pattern), so no lower-cased copy is kept. */
  text: string;
  /** Where the tool calls start in `text` (its length when there are none). */
  contentLength: number;
  /** Identifies this message's text across a conversation's branches, which
   * share history: one mention found in a fork and its parent is one. */
  fingerprint: string;
}

interface SessionDoc {
  id: string;
  messages: MessageDoc[];
}

/** One tool call as a line of text: its label, failed or not, and the
 * output it kept. */
function activityText(event: { kind: string; label: string; output?: readonly string[] }, outputLines = Number.POSITIVE_INFINITY): string {
  const status = event.kind === 'tool-error' ? ' (failed)' : event.kind === 'tool-start' ? ' (not finished)' : '';
  const output = (event.output ?? []).slice(0, outputLines).map((line) => `    ${line}`);
  return [`  ⏺ ${event.label}${status}`, ...output].join('\n');
}

function fingerprintOf(role: string, text: string): string {
  // FNV-1a over the text: identity, not security.
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${role}:${text.length}:${(hash >>> 0).toString(36)}`;
}

function messageDoc(message: TranscriptMessage): MessageDoc {
  const content = message.content ?? '';
  const calls = message.role === 'assistant' ? readTurnActivities(message.activities, content.length) : [];
  const text = calls.length ? `${content}\n${calls.map((activity) => activityText(activity.event)).join('\n')}` : content;
  return { role: message.role, text, contentLength: content.length, fingerprint: fingerprintOf(message.role, text) };
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordPatterns = new Map<string, RegExp>();

/** Where `word` (lower-cased) next appears in `text`, ignoring case; -1 when it does not. */
export function indexOfWord(text: string, word: string, from = 0): number {
  let pattern = wordPatterns.get(word);
  if (!pattern) {
    if (wordPatterns.size >= 256) wordPatterns.clear();
    pattern = new RegExp(escapeRegExp(word), 'gi');
    wordPatterns.set(word, pattern);
  }
  pattern.lastIndex = from;
  return pattern.exec(text)?.index ?? -1;
}

interface CacheEntry { key: string; doc: SessionDoc; chars: number }

/** By session file path, so two state directories (tests) never share. In
 * least-recently-used order (a Map keeps insertion order; a hit re-inserts),
 * bounded by the characters it holds: every transcript the machine has is
 * searched, and none of them needs to stay in memory for good. */
const cache = new Map<string, CacheEntry>();
let cacheChars = 32 * 1024 * 1024;
let cachedChars = 0;
/** Built views, likewise least recently used first; each holds its docs. */
const MAX_VIEWS = 32;

function uncache(path: string): void {
  const entry = cache.get(path);
  if (!entry) return;
  cache.delete(path);
  cachedChars -= entry.chars;
}

function remember(path: string, entry: CacheEntry): void {
  uncache(path);
  cache.set(path, entry);
  cachedChars += entry.chars;
  // The newest entry stays even alone over the budget: it is being searched now.
  for (const [oldest] of cache) {
    if (cachedChars <= cacheChars || oldest === path) break;
    uncache(oldest);
  }
}

const STATS = { builds: 0 };

/** How many transcripts were read and indexed since the process started. */
export function corpusBuilds(): number {
  return STATS.builds;
}

export function resetCorpusCache(): void {
  cache.clear();
  cachedChars = 0;
  views.clear();
}

/** For tests: how many transcripts are held, and their characters; and the budget. */
export function corpusCacheSize(): { docs: number; chars: number } {
  return { docs: cache.size, chars: cachedChars };
}
export function setCorpusCacheCharsForTests(chars: number): void { cacheChars = chars; }

/** One session's searchable messages, read only when its files changed. */
export async function sessionDoc(id: string): Promise<SessionDoc | undefined> {
  const path = sessionFilePath(id);
  const cached = cache.get(path);
  // Taken before the read: a write landing during it changes the identity,
  // so the next query reads again rather than keeping a stale copy.
  const key = await transcriptIdentity(id);
  if (cached && key !== undefined && key === cached.key) {
    remember(path, cached);
    return cached.doc;
  }
  if (key === undefined) {
    uncache(path);
    return undefined;
  }
  // A conversation whose log is gone has nothing to search; the listing and the audit say so.
  const transcript = await readSessionTranscript(id).catch((error: unknown) => {
    if (error instanceof ConversationLogMissingError) return undefined;
    throw error;
  });
  if (!transcript) {
    uncache(path);
    return undefined;
  }
  STATS.builds += 1;
  const doc: SessionDoc = { id, messages: (transcript.messages ?? []).map(messageDoc) };
  remember(path, { key, doc, chars: doc.messages.reduce((sum, message) => sum + message.text.length, 0) });
  return doc;
}

/** One message of a conversation as the user numbers it: which chat it is
 * stored in, and where. */
interface ViewEntry {
  sessionId: string;
  /** Its index in that chat's transcript. */
  index: number;
  message: MessageDoc;
  /** Set on the first message of a branch's own part (a fork that diverged
   * from the main line): the position of the message it follows, -1 when
   * it shares nothing. */
  forkAfter?: number;
}

/** A conversation's messages merged into one numbering: the newest chat's
 * transcript first (what opening the conversation shows, so its positions
 * are the ones the user sees), then each older branch's messages that the
 * ones before do not share, newest branch first. A branch shares the
 * longest common prefix it has with any branch placed before it. */
export interface ConversationView {
  entries: ViewEntry[];
  /** How many entries are the newest chat's own transcript. */
  mainLength: number;
  /** Per chat id: the position of each of its messages. */
  positions: Map<string, number[]>;
}

interface ViewCacheEntry { ids: string; docs: Array<SessionDoc | undefined>; view: ConversationView }

/** By the conversation's file path (so two state directories never share),
 * valid while its chats are the same and every one's doc is the very object
 * it was built from: sessionDoc returns the cached one while files are
 * unchanged. */
const views = new Map<string, ViewCacheEntry>();

function sharedPrefix(left: readonly MessageDoc[], right: readonly MessageDoc[]): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index]!.fingerprint === right[index]!.fingerprint) index += 1;
  return index;
}

function buildView(branches: ReadonlyArray<{ id: string; doc: SessionDoc | undefined }>): ConversationView {
  const entries: ViewEntry[] = [];
  const positions = new Map<string, number[]>();
  const placed: Array<{ messages: readonly MessageDoc[]; at: number[] }> = [];
  let mainLength = 0;
  for (const { id, doc } of branches) {
    if (!doc) continue;
    const messages = doc.messages;
    let shared = 0;
    let from: number[] = [];
    for (const other of placed) {
      const length = sharedPrefix(other.messages, messages);
      if (length > shared) { shared = length; from = other.at; }
    }
    const at = from.slice(0, shared);
    for (let index = shared; index < messages.length; index += 1) {
      at.push(entries.length);
      entries.push({ sessionId: id, index, message: messages[index]!, ...(placed.length && index === shared ? { forkAfter: shared ? from[shared - 1]! : -1 } : {}) });
    }
    if (!placed.length) mainLength = entries.length;
    placed.push({ messages, at });
    positions.set(id, at);
  }
  return { entries, mainLength, positions };
}

/** A conversation's merged messages (see ConversationView), rebuilt only
 * when one of its chats changed. */
export async function conversationView(group: Pick<ConversationGroup, 'id' | 'branches'>): Promise<ConversationView> {
  const docs = await Promise.all(group.branches.map((branch) => sessionDoc(branch.id)));
  const key = sessionFilePath(group.id);
  const ids = group.branches.map((branch) => branch.id).join(',');
  const cached = views.get(key);
  views.delete(key);
  if (cached?.ids === ids && cached.docs.every((doc, index) => doc === docs[index])) {
    views.set(key, cached);
    return cached.view;
  }
  const view = buildView(group.branches.map((branch, index) => ({ id: branch.id, doc: docs[index] })));
  views.set(key, { ids, docs, view });
  for (const [oldest] of views) {
    if (views.size <= MAX_VIEWS) break;
    views.delete(oldest);
  }
  return view;
}
