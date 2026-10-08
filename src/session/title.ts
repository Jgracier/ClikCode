/** What a conversation is called.
 *
 * It used to be the first message, truncated to 64 characters: "we need to
 * have scrolling but we need to not have terminal / co…". That is not a title,
 * it is the beginning of a sentence, and it tells a reader scanning a list of
 * forty chats nothing the first line of the chat would not.
 *
 * A title is the model's job. Where the harness already writes one -- Claude
 * Code names its own threads and records the name in its transcript -- that
 * one is used. Where it does not, one turn asks for one, and only once the
 * user's own words are specific enough to name the chat. A name, once set,
 * is never asked for again. A model that ignores the one request leaves the
 * chat unnamed. The answer is not rewritten except to drop the title marker
 * that one request told the model to write.
 */

import type { AiLocalHarnessDefinition } from '../harness/definition.js';
import type { HarnessSession } from './model.js';

/** Long enough to say what a chat is about, short enough to sit on the rule
 * above the composer next to everything else that lives there. */
export const SESSION_TITLE_MAX = 20;

/** `vendor` writes its own title into its own session file and ClikCode reads
 * it; `ask` has no such thing, so the turn asks for one; `none` gets none, and
 * an untitled chat shows its first message in the resume list instead. Each
 * harness declares which in the catalog (`titleSource`). */
export function sessionTitleSource(harness: AiLocalHarnessDefinition | undefined): 'vendor' | 'ask' | 'none' {
  return harness?.titleSource ?? 'ask';
}

/** The one request a chat may spend. Spent whether or not a title comes back,
 * so a chat is asked once and then never again. */
export const TITLE_REQUEST_ATTEMPTS = 1;

/** Words that never tell you what a chat is about. */
const TITLE_FILLER = new Set([
  'a', 'an', 'the', 'to', 'of', 'and', 'or', 'for', 'in', 'on', 'at', 'it', 'is', 'be', 'do', 'me', 'my',
  'this', 'that', 'please', 'just', 'can', 'you', 'we', 'ok', 'okay', 'yes', 'no', 'hi', 'hey', 'hello',
  'thanks', 'thank', 'continue', 'go', 'now', 'again', 'up', 'so', 'if', 'but',
]);

/** True once the user has said enough to name the chat. Two concrete words
 * across everything they have typed ("fix the parser", "login button").
 * A greeting or "do it" is not enough, and the attempt is not spent waiting. */
export function contextRichEnough(
  session: { messages?: ReadonlyArray<{ role?: string; content?: string }> },
  prompt: string,
): boolean {
  const said = [
    ...(session.messages ?? []).filter((message) => message.role === 'user').map((message) => message.content ?? ''),
    prompt,
  ].join(' ');
  const words = said.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter((word) => word.length > 2 && !TITLE_FILLER.has(word));
  return words.length >= 2;
}

/** Whether this turn should carry the one title request. */
export function shouldRequestTitle(
  session: Pick<HarnessSession, 'name' | 'titleAttempts' | 'messages'>, prompt: string,
): boolean {
  return !session.name && (session.titleAttempts ?? 0) < TITLE_REQUEST_ATTEMPTS && contextRichEnough(session, prompt);
}

/** Spend the conversation's single title request on this turn, if eligible.
 * No stream on any other turn: the reply is the model's, unmodified. */
export function prepareSessionTitle(
  session: Pick<HarnessSession, 'name' | 'titleAttempts' | 'messages'>, prompt: string,
): { prompt: string; stream?: StreamingTitle } {
  if (!shouldRequestTitle(session, prompt)) return { prompt };
  session.titleAttempts = (session.titleAttempts ?? 0) + 1;
  return { prompt: withTitleRequest(prompt), stream: new StreamingTitle() };
}

/** Whether the prompt about to be sent asks for a name.
 *
 * The prompt itself is the only honest source. The request is text appended to
 * one prompt -- so a retry that replaced that prompt (with "carry on", or with
 * a retelling of the interrupted turn) is not asking any more, whatever the
 * turn intended when it started. */
export function promptAsksForTitle(prompt: string): boolean {
  return prompt.includes(OPEN);
}

/** The title stream for the attempt about to run, from ONE rule: the stream
 * exists if and only if this attempt's prompt asks for a name, and every
 * attempt starts it over.
 *
 * Applied at the top of the retry loop, beside the other per-attempt resets,
 * rather than remembered at each retry site -- because there are five of those
 * in the native path alone (compatibility turn, re-login, invalid thread,
 * account failover, background-command continuation) and the first version of
 * this fix handled one. Both failure modes are silent: a stream carried across
 * a retry keeps the abandoned attempt's half-formed title AND, being settled,
 * hands the next reply's marker to the screen unstripped.
 *
 * A title already found is kept: it is this chat's name, and the rest of the
 * reply still has to flow through the settled stream. */
export function titleStreamForAttempt(
  current: StreamingTitle | undefined,
  prompt: string,
): StreamingTitle | undefined {
  if (current?.title) return current;
  if (!promptAsksForTitle(prompt)) return undefined;
  if (current) {
    current.restart();
    return current;
  }
  return new StreamingTitle();
}

const OPEN = '<clikcode-title>';
const CLOSE = '</clikcode-title>';

/** Appended to the first turn of an unnamed chat, and to no other turn. */
function titleRequest(): string {
  return `\n\n${OPEN}Start this reply only with a first line `
    + `${OPEN}a title${CLOSE} of at most ${SESSION_TITLE_MAX} characters naming what this `
    + `conversation is about (not what it literally says), then answer normally. `
    + `The user never sees that line. Never start a later reply with a title.${CLOSE}`;
}

export function withTitleRequest(prompt: string): string {
  return `${prompt}${titleRequest()}`;
}

/** Whether a message ends with a title request (any wording ClikCode used):
 * one ClikCode sent. */
export function carriesTitleRequest(text: string): boolean {
  return new RegExp(`\\n\\n${OPEN}[\\s\\S]*${CLOSE}\\s*$`).test(text);
}

/** Collapsed, unquoted, and cut to the limit on a word boundary where there is
 * one, so a model that ignores the length still produces something readable. */
export function normalizeSessionTitle(raw: string): string | undefined {
  const text = raw.replace(/\s+/g, ' ').replace(/^["'`]|["'`]$/g, '').replace(/[.。]+$/, '').trim();
  if (!text) return undefined;
  if (text.length <= SESSION_TITLE_MAX) return text;
  const cut = text.slice(0, SESSION_TITLE_MAX);
  const space = cut.lastIndexOf(' ');
  return (space >= SESSION_TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd();
}

/** The title marker this one request puts at the front of a reply, and the
 * reply without that marker. Anything else, including a short first line or
 * a line that happens to say "Title:", is the answer. */
export function extractSessionTitle(answer: string): { title?: string; text: string } {
  const match = new RegExp(`^\\s*${OPEN}([\\s\\S]*?)${CLOSE}[ \\t]*\\r?\\n?`).exec(answer);
  if (!match) return { text: answer };
  const title = normalizeSessionTitle(match[1] ?? '');
  const text = answer.slice(match[0].length);
  return { ...(title ? { title } : {}), text };
}

/** A reply with a title line removed wherever a step began with one -- the
 * start of the reply or of any paragraph -- for a multi-step reply whose later
 * steps repeated the title the first step gave. */
export function stripRepeatedTitles(text: string): string {
  return text.replace(new RegExp(`(^|\\n)[ \\t]*${OPEN}[\\s\\S]*?${CLOSE}[ \\t]*\\r?\\n?`, 'g'), '$1').replace(/^\n+/, '');
}

/** How much of a reply has to arrive before it is clear no title is coming:
 * the open tag, plus room for a model that pads it with a word or two first. */
const DECIDE_AFTER = OPEN.length + 64;

/** Holds back the head of a streaming reply until it is clear whether it opens
 * with a title, so the tag never reaches the screen -- and releases everything
 * untouched the moment it is clear it does not.
 *
 * `replace` deltas carry the whole answer each time, so they need no holding;
 * `append` deltas do, and nothing is emitted until the question is settled. */
export class StreamingTitle {
  private buffer = '';
  private settled = false;
  private found?: string;
  /** This stream exists only on the turn that asked. */
  readonly naming = true;

  /** The title, once the stream has produced one. */
  get title(): string | undefined { return this.found; }

  /** What the caller may show, or undefined while the head is still in doubt. */
  push(text: string, mode: 'append' | 'replace'): string | undefined {
    // A 'replace' carries the WHOLE answer again, title line included, so the
    // tag has to be stripped from every one of them -- not just the delta that
    // happened to settle this. Returning it verbatim put the raw
    // <clikcode-title> tag on screen, and left the displayed answer different
    // from the cleaned one that gets persisted; the transcript then treated
    // the saved copy as new text and emitted the whole reply a second time.
    // That is the duplicated response.
    if (this.settled) return mode === 'replace' ? extractSessionTitle(text).text : text;
    this.buffer = mode === 'replace' ? text : this.buffer + text;
    const extracted = extractSessionTitle(this.buffer);
    if (extracted.title !== undefined || !this.couldStillOpen()) {
      this.settled = true;
      this.found = extracted.title;
      return extracted.text;
    }
    return mode === 'replace' ? '' : undefined;
  }

  /** A new reply attempt for the SAME request: an account switch that
   * re-sends the prompt, or a transport fallback. Whatever the abandoned
   * attempt held back, and whatever title it had begun, belongs to a reply
   * nobody will ever see -- and a stream left settled would hand the NEW
   * reply's title marker straight to the screen, because a settled stream
   * passes append deltas through verbatim. */
  /** The next model step of the SAME reply. A multi-step agent re-sends the
   * conversation -- title request included -- on every step, and a model may
   * open each step's text with the title again. Watch the start of this step
   * as closely as the first; the title already found is kept. */
  nextStep(): void {
    this.buffer = '';
    this.settled = false;
  }

  restart(): void {
    this.buffer = '';
    this.settled = false;
    this.found = undefined;
  }

  /** The stream ended: whatever was held back is owed to the caller. */
  flush(): string | undefined {
    if (this.settled) return undefined;
    this.settled = true;
    const extracted = extractSessionTitle(this.buffer);
    this.found = extracted.title;
    return extracted.text;
  }

  /** Hold only while the bytes so far are the title marker. Any other opening
   * is the answer and goes out immediately. */
  private couldStillOpen(): boolean {
    const head = this.buffer.replace(/^\s+/, '');
    if (head.length < OPEN.length && OPEN.startsWith(head)) return true;
    if (head.startsWith(OPEN) && !head.includes(CLOSE)) return this.buffer.length < DECIDE_AFTER + OPEN.length;
    return false;
  }
}
