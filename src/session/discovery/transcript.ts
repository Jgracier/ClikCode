/** Reading a prior conversation back out: what a message is, which parts of
 * one are the user's own words, and how an imported transcript merges with
 * what ClikCode already has. */

import { normalizeImportedTranscript } from '../../turn/failover-prompt.js';

export type NativeTranscriptMessage = { role: 'user' | 'assistant'; content: string };

/** Reconcile a cached ClikCode transcript with the vendor-owned source without
 * destroying context carried across providers. Native transcripts are often
 * bounded windows, so replacement is unsafe: find the longest suffix of the
 * cache that occurs in the source window and append only source messages that
 * follow it. With no overlap, retain the cache; with no cache, adopt source. */
export function mergeNativeTranscript(
  cached: readonly NativeTranscriptMessage[], source: readonly NativeTranscriptMessage[],
): NativeTranscriptMessage[] {
  // Both sides go through the same normalization so the overlap search below
  // still compares like with like, and so a rehydration prompt the vendor
  // recorded never re-enters ClikCode's transcript.
  cached = normalizeImportedTranscript(cached);
  source = normalizeImportedTranscript(source);
  if (!cached.length) return [...source];
  if (!source.length) return [...cached];
  const equal = (left: NativeTranscriptMessage, right: NativeTranscriptMessage): boolean =>
    left.role === right.role && left.content === right.content;
  const maxOverlap = Math.min(cached.length, source.length);
  for (let length = maxOverlap; length > 0; length -= 1) {
    const cachedStart = cached.length - length;
    for (let sourceStart = source.length - length; sourceStart >= 0; sourceStart -= 1) {
      let matches = true;
      for (let offset = 0; offset < length; offset += 1) {
        if (!equal(cached[cachedStart + offset]!, source[sourceStart + offset]!)) { matches = false; break; }
      }
      if (matches) return [...cached, ...source.slice(sourceStart + length)];
    }
  }
  return [...cached];
}

/** Both Claude Code and Codex represent a message's content as either a plain
 * string or a list of content blocks ({type:'text', text:'...'}, possibly
 * mixed with non-text blocks like tool calls) — real API message shapes, not
 * one canonical format. Used for both title extraction (first real message)
 * and full transcript reading (every message), so a session that happens to
 * use the array shape gets the same treatment either way instead of only
 * being fixed for the one caller that was reported broken. */
export function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => typeof (part as { text?: unknown })?.text === 'string' ? (part as { text: string }).text : '').join(' ').trim();
}

/** Remove client-owned context envelopes from a native user turn while
 * retaining the actual prompt. Codex records IDE context as part of the user
 * item; importing that wrapper verbatim makes the ClikCode transcript look as
 * if the same request was pasted several times. Unknown content is preserved. */
export function visibleNativeUserText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('<')) return '';
  if (trimmed.startsWith('# Context from my IDE setup:')) {
    const marker = '\n## My request:\n';
    const requestStart = trimmed.indexOf(marker);
    if (requestStart >= 0) return trimmed.slice(requestStart + marker.length).trim();
  }
  return trimmed;
}

// Large enough that an externally continued thread still overlaps ClikCode's
// cached suffix; bounded so opening a years-long vendor history cannot bloat
// the local state file without limit.

export const ADOPTED_TRANSCRIPT_LIMIT = 200;
