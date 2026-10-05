/**
 * Read ClikCode's rehydration (transfer) prompt back out of a vendor
 * transcript. The prompt itself is built by turn/transfer.ts.
 *
 * On failover ClikCode sends the vendor a retelling of the conversation so the
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

/** The tags of the frame a transfer prompt (turn/transfer.ts) is built
 * from. Content inside it is data: only these tags are neutralized, so code
 * in the transcript (generics, JSX, HTML) stays readable while `</message>`
 * in a message can no longer end it early and smuggle the rest in as a forged
 * turn or request. */
const FRAME_TAGS = 'message|conversation|current_request|touched_files|requests|tool_digest|attachments|open_todos';
const ESCAPE = new RegExp(`<(\\/?)(${FRAME_TAGS})\\b`, 'gi');
const UNESCAPE = new RegExp(`&lt;(\\/?)(${FRAME_TAGS})\\b`, 'gi');

export function escapeFailoverContent(text: string): string {
  return text.replace(ESCAPE, '&lt;$1$2');
}

/** Inverse of `escapeFailoverContent`: restore frame tags the prompt neutered. */
function unescapeFailoverContent(text: string): string {
  return text.replace(UNESCAPE, '<$1$2');
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

/** What ClikCode sends to carry on an interrupted turn. It is plumbing like
 * the preamble: the user's request is the interrupted turn's own prompt, so
 * this is never stored, shown or replayed as something they typed. */
export const INTERRUPTED_TURN_REQUEST = 'Continue the interrupted latest request. Inspect the current workspace first and finish the remaining work without repeating completed steps.';

/** The line a written native thread opens each provider switch with
 * (session/canonical.ts markProviderBoundaries). Plumbing too: read back out
 * of a vendor's transcript, it is stripped. */
export const providerBoundaryNote = (label: string): string => `[ClikCode: the following turns ran on ${label}]`;
const PROVIDER_BOUNDARY_NOTE = /^\[ClikCode: the following turns ran on [^\n]*\](?:\s*\n|\s*$)\s*/;

/** Replace any rehydration prompt in an imported transcript with the request
 * it carried, drop a bare INTERRUPTED_TURN_REQUEST, and strip a provider
 * boundary note. Idempotent: the result no longer begins with the preamble
 * or a note. A prompt with nothing recoverable is dropped rather than left
 * blank. */
export function normalizeImportedTranscript<T extends { role: string; content: string }>(
  messages: readonly T[],
): T[] {
  const normalized: T[] = [];
  for (const original of messages) {
    if (original.role !== 'user') { normalized.push(original); continue; }
    const content = original.content.replace(PROVIDER_BOUNDARY_NOTE, '');
    if (content !== original.content && !content.trim()) continue;
    const message = content === original.content ? original : { ...original, content };
    if (message.content.trim() === INTERRUPTED_TURN_REQUEST) continue;
    const request = failoverPromptRequest(message.content);
    if (request === undefined) normalized.push(message);
    // A transfer that continued an interrupted turn carried ClikCode's own
    // request, not the user's: nothing of it is theirs.
    else if (request && request !== INTERRUPTED_TURN_REQUEST) normalized.push({ ...message, content: request });
  }
  return normalized;
}
