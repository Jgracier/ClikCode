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
export function reconcileNativeTranscript(
  cached: readonly NativeTranscriptMessage[], source: readonly NativeTranscriptMessage[],
): { messages: NativeTranscriptMessage[]; appendedFrom: number; overlapLength: number } {
  // Both sides go through the same normalization so the overlap search below
  // still compares like with like, and so a rehydration prompt the vendor
  // recorded never re-enters ClikCode's transcript.
  cached = normalizeImportedTranscript(cached);
  source = normalizeImportedTranscript(source);
  if (!cached.length) return { messages: [...source], appendedFrom: 0, overlapLength: 0 };
  if (!source.length) return { messages: [...cached], appendedFrom: cached.length, overlapLength: 0 };
  // Whitespace-insensitive on purpose: ClikCode's own cached copy of a
  // message and the vendor's freshly re-read copy of the SAME message are not
  // always byte-identical (a live-streamed reply can carry a paragraph break
  // a tool call inserted that the vendor's own stored text does not). Every
  // window this search tries is a SUFFIX of `cached`, so one mismatched
  // message at the very end poisoned every window length, not just the
  // longest -- the whole merge fell back to `[...cached]`, silently dropping
  // every genuinely new turn the vendor had recorded after it.
  const key = (message: NativeTranscriptMessage): string => `${message.role}\0${message.content.replace(/\s+/g, ' ').trim()}`;
  // Searching reversed messages makes a cache suffix a pattern prefix. KMP
  // finds the longest match in linear time, even in years of repeated turns.
  // Scanning from the source's end preserves the most recent equal overlap.
  const pattern = cached.map(key).reverse();
  const fallback = new Array<number>(pattern.length).fill(0);
  for (let index = 1, matched = 0; index < pattern.length; index += 1) {
    while (matched && pattern[index] !== pattern[matched]) matched = fallback[matched - 1]!;
    if (pattern[index] === pattern[matched]) matched += 1;
    fallback[index] = matched;
  }
  let length = 0;
  let sourceStart = 0;
  for (let index = source.length - 1, matched = 0; index >= 0; index -= 1) {
    const value = key(source[index]!);
    while (matched && value !== pattern[matched]) matched = fallback[matched - 1]!;
    if (value === pattern[matched]) matched += 1;
    if (matched > length) { length = matched; sourceStart = index; }
    if (matched === pattern.length) break;
  }
  if (length) {
    // Only a source containing the entire cache proves its missing prefix.
    const prefix = length === cached.length ? source.slice(0, sourceStart) : [];
    return { messages: [...prefix, ...cached, ...source.slice(sourceStart + length)], appendedFrom: prefix.length + cached.length, overlapLength: length };
  }
  return { messages: [...cached], appendedFrom: cached.length, overlapLength: 0 };
}

export function mergeNativeTranscript(cached: readonly NativeTranscriptMessage[], source: readonly NativeTranscriptMessage[]): NativeTranscriptMessage[] {
  return reconcileNativeTranscript(cached, source).messages;
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
  let trimmed = text.trim();
  // Native startup envelopes are metadata; an ordinary request beginning
  // with HTML/XML is still the user's message. Keep any words after a known
  // envelope rather than discarding the entire user turn with it.
  const envelope = /^<(recommended_plugins|environment_context|user_instructions|developer_instructions|system-reminder|local-command-caveat|local-command-stdout|ide_opened_file|ide_selection|task-notification)\b[^>]*>[\s\S]*?<\/\1>\s*/i;
  while (envelope.test(trimmed)) trimmed = trimmed.replace(envelope, '');
  if (!trimmed) return '';
  if (trimmed.startsWith('# Context from my IDE setup:')) {
    const marker = '\n## My request:\n';
    const requestStart = trimmed.indexOf(marker);
    if (requestStart >= 0) return trimmed.slice(requestStart + marker.length).trim();
  }
  return trimmed;
}

/** The first `"text"` or string `"content"` in a JSONL line, as far as the
 * line goes: a bounded read cuts a long message -- a transfer prompt is the
 * whole conversation -- off mid-string, and its opening is still there. */
export function leadingText(line: string): string | undefined {
  const match = /"(?:text|content)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(line);
  if (!match) return undefined;
  const escaped = match[1]!.replace(/\\u?[0-9a-fA-F]{0,3}$|\\$/, '');
  try { return JSON.parse(`"${escaped}"`) as string; } catch { return escaped; }
}
