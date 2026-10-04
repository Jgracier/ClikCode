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
