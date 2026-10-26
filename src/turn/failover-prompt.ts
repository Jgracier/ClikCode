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

import { carriesTitleRequest } from '../session/title.js';
import { stripResourceNotes } from './resource-note-text.js';

/** Opening line of every transfer prompt; the marker that identifies one. A
 * statement of fact about the text that follows, not an instruction: the
 * model is told nothing about what to do with the conversation. */
export const FAILOVER_PREAMBLE = 'Earlier in this chat (carried over from another account, provider or machine):';

/** Preambles ClikCode wrote before, still recognized in vendor transcripts
 * recorded with them. */
const EARLIER_PREAMBLES = [
  'The conversation below took place earlier in this chat; you are continuing it. Treat it as what you already know, answer only the current request, and do not mention this note or that the chat moved.',
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
  const framed = (value: string): boolean => [FAILOVER_PREAMBLE, ...EARLIER_PREAMBLES].some((preamble) => value.startsWith(preamble));
  if (!framed(text)) return undefined;
  // Older retries could wrap a prepared handoff again. Importing those must
  // recover the original request too, and remain idempotent.
  let current = text;
  while (framed(current)) {
    const request = /<current_request>\n([\s\S]*?)\n<\/current_request>\s*$/.exec(current)?.[1];
    const next = unescapeFailoverContent(request ?? '').trim();
    if (next.length >= current.length) return '';
    current = next;
  }
  return current;
}

/** What older ClikCode builds sent a vendor to carry on an interrupted turn.
 * ClikCode no longer sends it (a failed turn is asked again in the user's own
 * words); it is only recognized in records written then, so none of them
 * shows or replays it as something the user typed. */
export const LEGACY_INTERRUPTED_TURN_REQUEST = 'Continue the interrupted latest request. Inspect the current workspace first and finish the remaining work without repeating completed steps.';

/** The line older builds wrote into a vendor's native thread at each provider
 * switch. No longer written (the vendor's thread is the vendor's own), and
 * the agent's seed (turn/agent-history.ts) still names it for its own use;
 * read back out of a vendor's transcript, it is stripped. */
export const providerBoundaryNote = (label: string): string => `[ClikCode: the following turns ran on ${label}]`;
const PROVIDER_BOUNDARY_NOTE = /^\[ClikCode: the following turns ran on [^\n]*\](?:\s*\n|\s*$)\s*/;

/** Whether a vendor thread opening with `text` (its first user message, or a
 * title made from it) is one ClikCode wrote: a conversation carried over as a
 * transfer prompt, a written thread opening on a provider boundary note, or
 * a first turn ClikCode asked for a title in (read whole).
 * Leading quotes and space are not the opening: one vendor's CLI was handed
 * the prompt quoted. */
export function isClikCodeOpening(text: string): boolean {
  const opening = text.replace(/^[\s"']+/, '');
  return CLIKCODE_OPENINGS.some((start) => opening.startsWith(start)) || carriesTitleRequest(text);
}

/** Enough of each opening to know it, even from a title or a cut-off read. */
const CLIKCODE_OPENINGS = [...[FAILOVER_PREAMBLE, ...EARLIER_PREAMBLES].map((preamble) => preamble.slice(0, 40)), providerBoundaryNote('').slice(0, -1)];

/** Replace any rehydration prompt in an imported transcript with the request
 * it carried, drop a bare legacy continuation request, and strip a provider
 * boundary note and any resource note. Idempotent: the result no longer begins with the preamble
 * or a note. A prompt with nothing recoverable is dropped rather than left
 * blank. */
export function normalizeImportedTranscript<T extends { role: string; content: string }>(
  messages: readonly T[],
): T[] {
  const normalized: T[] = [];
  for (const original of messages) {
    if (original.role !== 'user') {
      // Old workers recorded a completion with only the ACP placeholder
      // "tool" as if it were an assistant reply. It carries no result.
      if (original.role === 'assistant' && /^Background work finished: (?:failed )?tool\.$/.test(original.content.trim())) continue;
      normalized.push(original);
      continue;
    }
    // Claude writes task completion notices as role:user in its native
    // transcript. They are vendor events, never a prompt the user typed.
    if (/^<task-notification\b[^>]*>[\s\S]*?<\/task-notification>\s*$/.test(original.content.trim())) continue;
    // A resource note ClikCode sent the model (turn/resource-notes.ts) is not
    // the user's: one steered in alone is dropped, one on a turn's text cut off it.
    const content = stripResourceNotes(original.content.replace(PROVIDER_BOUNDARY_NOTE, ''));
    if (content !== original.content && !content.trim()) continue;
    const message = content === original.content ? original : { ...original, content };
    if (message.content.trim() === LEGACY_INTERRUPTED_TURN_REQUEST) continue;
    const request = failoverPromptRequest(message.content);
    if (request === undefined) normalized.push(message);
    // A transfer that continued an interrupted turn carried ClikCode's own
    // request, not the user's: nothing of it is theirs.
    else if (request && request !== LEGACY_INTERRUPTED_TURN_REQUEST) normalized.push({ ...message, content: request });
  }
  return normalized;
}
