/** Every conversation's saved messages as searchable text, cached per
 * transcript.
 *
 * A message's text is what it says and then, for an assistant message, a
 * compact line per tool call it made (its label and the output it kept), so
 * "the command that printed X" is findable too. Offsets into that text are
 * the anchors search hands out.
 *
 * The cache is keyed on the files a transcript is made of -- its own and
 * each parent a fork reference points into -- by mtime and size. Never a
 * clock: an unchanged file is never read again, and a changed one is never
 * served stale, however soon after it was written. */

import { stat } from 'node:fs/promises';
import type { TranscriptMessage } from '../session/model.js';
import type { ConversationGroup } from './conversations.js';
import { sessionFilePath } from '../session/store/paths.js';
import { loadSessionFile } from '../session/store/records.js';
import { readSessionTranscript } from '../session/store/transcripts.js';
import { readTurnActivities } from '../turn/turn-activities.js';

export interface MessageDoc {
  role: 'user' | 'assistant';
  /** Content, then one block per tool call. */
  text: string;
  /** `text` lower-cased, once, for matching. */
  lower: string;
  /** Where the tool calls start in `text` (its length when there are none). */
  contentLength: number;
  /** Identifies this message's text across a conversation's branches, which
   * share history: one mention found in a fork and its parent is one. */
  fingerprint: string;
}

export interface SessionDoc {
  id: string;
  messages: MessageDoc[];
}

/** One tool call as a line of text: its label, failed or not, and the
 * output it kept. */
export function activityText(event: { kind: string; label: string; output?: readonly string[] }, outputLines = Number.POSITIVE_INFINITY): string {
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

export function messageDoc(message: TranscriptMessage): MessageDoc {
  const content = message.content ?? '';
  const calls = message.role === 'assistant' ? readTurnActivities(message.activities, content.length) : [];
  const text = calls.length ? `${content}\n${calls.map((activity) => activityText(activity.event)).join('\n')}` : content;
  return { role: message.role, text, lower: text.toLowerCase(), contentLength: content.length, fingerprint: fingerprintOf(message.role, text) };
}

interface CacheEntry { chain: string[]; key: string; doc: SessionDoc }

/** By session file path, so two state directories (tests) never share. */
const cache = new Map<string, CacheEntry>();

const STATS = { builds: 0 };

/** How many transcripts were read and indexed since the process started. */
export function corpusBuilds(): number {
  return STATS.builds;
}

export function resetCorpusCache(): void {
  cache.clear();
  views.clear();
}

/** The identity of a transcript: each file it is read from. Undefined when
 * its own file is gone. */
async function identity(chain: readonly string[]): Promise<string | undefined> {
  const parts = await Promise.all(chain.map(async (id, index) => {
    const info = await stat(sessionFilePath(id)).catch(() => undefined);
    if (!info) return index === 0 ? undefined : `${id}:-`;
    return `${id}:${info.mtimeMs}:${info.size}`;
  }));
  return parts.includes(undefined) ? undefined : parts.join('|');
}

/** The session and every parent its history is read through. */
async function referenceChain(id: string): Promise<string[]> {
  const chain = [id];
  let ref = (await loadSessionFile(id))?.transcriptRef;
  while (ref && !chain.includes(ref.sessionId) && chain.length < 64) {
    chain.push(ref.sessionId);
    ref = (await loadSessionFile(ref.sessionId))?.transcriptRef;
  }
  return chain;
}

/** One session's searchable messages, read only when its files changed. */
export async function sessionDoc(id: string): Promise<SessionDoc | undefined> {
  const path = sessionFilePath(id);
  const cached = cache.get(path);
  if (cached && await identity(cached.chain) === cached.key) return cached.doc;
  const chain = await referenceChain(id);
  // Taken before the read: a write landing during it changes the identity,
  // so the next query reads again rather than keeping a stale copy.
  const key = await identity(chain);
  if (key === undefined) {
    cache.delete(path);
    return undefined;
  }
  const transcript = await readSessionTranscript(id);
  STATS.builds += 1;
  const doc: SessionDoc = { id, messages: (transcript.messages ?? []).map(messageDoc) };
  cache.set(path, { chain, key, doc });
  return doc;
}

/** One message of a conversation as the user numbers it: which chat it is
 * stored in, and where. */
export interface ViewEntry {
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

export function buildView(branches: ReadonlyArray<{ id: string; doc: SessionDoc | undefined }>): ConversationView {
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
  if (cached?.ids === ids && cached.docs.every((doc, index) => doc === docs[index])) return cached.view;
  const view = buildView(group.branches.map((branch, index) => ({ id: branch.id, doc: docs[index] })));
  views.set(key, { ids, docs, view });
  return view;
}
