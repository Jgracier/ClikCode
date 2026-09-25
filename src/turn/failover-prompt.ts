/**
 * Reading ClikCode's own rehydration prompt back out of a vendor transcript.
 *
 * On failover ClikCode sends the vendor a replay of the conversation so the
 * new account resumes with context. The vendor records what it was sent,
 * verbatim -- so every later import of that native thread (a transcript sync,
 * a `/resume`, a handoff) brings the whole replay back in as one enormous user
 * message: the preamble, every prior message, and the `<touched_files>` list.
 * That is what surfaced in chat as a wall of filepaths after a Codex turn ran
 * out of quota, and what a session then took its title from.
 *
 * Only the request the prompt carried was ever the user's; the rest is
 * ClikCode's own plumbing and belongs nowhere near the transcript.
 */

/** Opening line of every rehydration prompt; the marker that identifies one.
 *
 * Written as context, not as a task. The earlier wording ("Continue the same
 * ClikCode conversation after an account or provider failover…") read to a
 * small model as the thing to do: handed a chat moved from Aider, a free
 * OpenRouter model on Goose answered "test" with a "Failover Continuity
 * Confirmed" status report, tables and all. */
export const FAILOVER_PREAMBLE = 'The conversation below took place earlier in this chat; you are continuing it. Treat it as what you already know, answer only the current request, and do not mention this note or that the chat moved.';

/** Preambles ClikCode wrote before, still recognized in vendor transcripts
 * recorded with them. */
const EARLIER_PREAMBLES = [
  'Continue the same ClikCode conversation after an account or provider failover. Preserve all prior decisions, files, and task state. Do not repeat completed work.',
];

/** Inverse of `escapeFailoverContent`: restore frame tags the prompt neutered. */
function unescapeFailoverContent(text: string): string {
  return text.replace(/&lt;(\/?)(message|conversation|current_request|touched_files)\b/gi, '<$1$2');
}

/** The user request a rehydration prompt carried, or undefined if `text` is
 * not one. An unparsable prompt yields '' rather than undefined so callers
 * still replace it -- a malformed frame is no more worth showing than a
 * well-formed one. */
export function failoverPromptRequest(text: string): string | undefined {
  if (![FAILOVER_PREAMBLE, ...EARLIER_PREAMBLES].some((preamble) => text.startsWith(preamble))) return undefined;
  const request = /<current_request>\n([\s\S]*?)\n<\/current_request>\s*$/.exec(text)?.[1];
  return unescapeFailoverContent(request ?? '').trim();
}

/** Replace any rehydration prompt in an imported transcript with the request
 * it carried. Idempotent: the result no longer begins with the preamble.
 * A prompt with nothing recoverable is dropped rather than left blank. */
export function normalizeImportedTranscript<T extends { role: string; content: string }>(
  messages: readonly T[],
): T[] {
  const normalized: T[] = [];
  for (const message of messages) {
    if (message.role !== 'user') { normalized.push(message); continue; }
    const request = failoverPromptRequest(message.content);
    if (request === undefined) normalized.push(message);
    else if (request) normalized.push({ ...message, content: request });
  }
  return normalized;
}
