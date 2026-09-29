/**
 * Create and read ClikCode's rehydration prompt for a vendor transcript.
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

/**
 * Caps how much prior transcript gets replayed into a fresh native thread.
 * Uncapped replay grows every prompt's cost and context-window usage in lockstep
 * with total conversation length, on every provider/account switch — bounding it
 * to the most recent exchanges keeps switching cheap regardless of how long the
 * conversation has run.
 */
const MAX_REPLAY_MESSAGES = 40;
/** Total UTF-8 budget for a rehydration prompt. A message count alone bounds
 * nothing: forty messages of pasted logs is megabytes, which overflows argv
 * (E2BIG) for prompt-as-argument harnesses and the context window for all. */
const FAILOVER_PROMPT_MAX_BYTES = 48 * 1024;
/** Newest messages replayed verbatim (budget permitting). */
const VERBATIM_MESSAGES = 6;
/** Cap for each older message. */
const OLDER_MESSAGE_MAX_BYTES = 2 * 1024;

export interface FailoverPromptOptions {
  /** Total prompt budget in UTF-8 bytes. Defaults to FAILOVER_PROMPT_MAX_BYTES. */
  maxBytes?: number;
  /** Files the interrupted turn had started changing. */
  touchedFiles?: readonly string[];
}

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** Transcript content is data inside an XML-ish frame. Only the frame's own
 * tags are neutralized, so code in the transcript (generics, JSX, HTML) stays
 * readable while `</message>` in a message can no longer end it early and
 * smuggle the rest in as a forged turn or request. */
function escapeFailoverContent(text: string): string {
  return text.replace(/<(\/?)(message|conversation|current_request|touched_files)\b/gi, '&lt;$1$2');
}

function sliceBytes(text: string, maxBytes: number, from: 'start' | 'end'): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  const part = from === 'start' ? buffer.subarray(0, maxBytes) : buffer.subarray(buffer.length - maxBytes);
  // Drop the partial code point a byte cut can leave at either edge.
  return part.toString('utf8').replace(/^�+|�+$/g, '');
}

/** Head and tail of an over-long message: how it began and where it ended up. */
function truncateMiddle(text: string, maxBytes: number): string {
  const total = bytes(text);
  if (total <= maxBytes) return text;
  const room = Math.max(64, maxBytes - 64);
  const head = sliceBytes(text, Math.ceil(room * 0.6), 'start');
  const tail = sliceBytes(text, Math.floor(room * 0.4), 'end');
  return `${head}\n[… ${total - bytes(head) - bytes(tail)} bytes truncated …]\n${tail}`;
}

/** Rehydrate a new vendor-native session after switching account profiles or providers. */
export function failoverPrompt(
  messages: readonly { role: 'user' | 'assistant'; content: string }[],
  currentPrompt: string,
  options: FailoverPromptOptions = {},
): string {
  const maxBytes = Math.max(1024, options.maxBytes ?? FAILOVER_PROMPT_MAX_BYTES);
  const preamble = FAILOVER_PREAMBLE;
  const touched = (options.touchedFiles ?? []).filter((file) => file.trim());
  const touchedBlock = touched.length
    ? `\n\n<touched_files>\nThe interrupted turn had started changing these files; they may be partially edited. Check each before editing again:\n${touched.map((file) => `- ${escapeFailoverContent(file)}`).join('\n')}\n</touched_files>`
    : '';
  // The current request is what the user actually asked for: it is never
  // dropped, only (pathologically) trimmed so the frame itself still fits.
  const request = truncateMiddle(escapeFailoverContent(currentPrompt), Math.floor(maxBytes * 0.5));
  const fixed = bytes(preamble) + bytes(touchedBlock) + bytes(request) + 160;
  let remaining = Math.max(0, maxBytes - fixed);

  const recent = messages.slice(-MAX_REPLAY_MESSAGES);
  const kept: string[] = [];
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const message = recent[index]!;
    const age = recent.length - 1 - index;
    const escaped = escapeFailoverContent(message.content);
    const frame = `<message role="${message.role}">\n\n</message>\n`;
    const room = remaining - bytes(frame);
    if (room < 128) break;
    const content = truncateMiddle(escaped, age < VERBATIM_MESSAGES ? room : Math.min(room, OLDER_MESSAGE_MAX_BYTES));
    kept.unshift(`<message role="${message.role}">\n${content}\n</message>`);
    remaining -= bytes(frame) + bytes(content);
  }
  const omitted = messages.length - kept.length;
  const note = omitted > 0 ? `\n\n(${omitted} earlier message${omitted === 1 ? '' : 's'} omitted for brevity.)` : '';
  return `${preamble}\n\n<conversation>${note}\n${kept.join('\n')}\n</conversation>${touchedBlock}\n\n<current_request>\n${request}\n</current_request>`;
}

export const INTERRUPTED_TURN_REQUEST = 'Continue the interrupted latest request. Inspect the current workspace first and finish the remaining work without repeating completed steps.';
