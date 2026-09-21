/** Finding the vendor's own session id in its output, whatever it calls it. */

import { asRecord, parseJsonDocument, parseJsonLines } from './json-lines.js';

const SESSION_KEY = /^(?:session_?id|thread_?id|chat_?id|conversation_?id|session)$/i;

/** The key each vendor documents for its own resumable identity. A harness
 * listed here never has another key's value preferred over this one. */
const HARNESS_SESSION_KEYS: Readonly<Record<string, readonly string[]>> = {
  claude: ['session_id'], qwen: ['session_id'], cursor: ['session_id'],
  droid: ['session_id'], pi: ['session_id', 'sessionId'], codex: ['thread_id'],
  antigravity: ['conversation_id'], opencode: ['sessionID'], kilo: ['sessionID'],
};

/** Envelopes that introduce a session, where a bare `id` IS the session id. */
const SESSION_ENVELOPE_TYPE = /(?:^|[._-])(?:session|thread|conversation|chat|init|task)(?:$|[._-])/i;

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;

/** Session identities found in a turn's output, most trustworthy first.
 *
 * Structured output is only ever read through explicit keys (the harness's own
 * documented key first), plus a bare `id` on a top-level session-introducing
 * envelope. The generic "any `id`" and "any UUID in the text" heuristics are
 * reserved for text-mode harnesses: in a JSON stream they match tool-call ids
 * and UUIDs the model merely printed, and a wrong id silently forks the
 * conversation on the next resume. */
export function nativeSessionIds(
  outputText: string, format: 'json' | 'json-lines' | 'text' = 'text', harnessCommand?: string,
): Set<string> {
  if (format === 'text') {
    const ids = new Set<string>();
    const labelled = /(?:session|thread|chat|conversation)(?:\s+id)?\s*[:=]\s*([\w-]{8,})/i.exec(outputText)?.[1];
    if (labelled) ids.add(labelled);
    for (const match of outputText.matchAll(UUID)) ids.add(match[0]);
    return ids;
  }
  return nativeSessionIdsFromValues(format === 'json' ? parseJsonDocument(outputText) : parseJsonLines(outputText).values, harnessCommand);
}

/** nativeSessionIds over already-parsed structured records. */
export function nativeSessionIdsFromValues(values: readonly unknown[], harnessCommand?: string): Set<string> {
  const preferredKeys = new Set(harnessCommand ? HARNESS_SESSION_KEYS[harnessCommand] ?? [] : []);
  const preferred = new Set<string>();
  const explicit = new Set<string>();
  const envelope = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (Array.isArray(value)) return value.forEach((item) => visit(item, depth + 1));
    const record = asRecord(value);
    if (!record) return;
    for (const [key, child] of Object.entries(record)) {
      if (typeof child === 'string') {
        if (!child.trim()) continue;
        if (preferredKeys.has(key)) preferred.add(child.trim());
        else if (SESSION_KEY.test(key)) explicit.add(child.trim());
        else if (key === 'id' && depth === 0 && SESSION_ENVELOPE_TYPE.test(String(record.type ?? record.event ?? ''))) envelope.add(child.trim());
      } else visit(child, depth + 1);
    }
  };
  for (const value of values) visit(value, 0);
  return new Set<string>([...preferred, ...explicit, ...envelope]);
}
