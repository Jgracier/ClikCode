/** What a conversation is called.
 *
 * It used to be the first message, truncated to 64 characters: "we need to
 * have scrolling but we need to not have terminal / co…". That is not a title,
 * it is the beginning of a sentence, and it tells a reader scanning a list of
 * forty chats nothing the first line of the chat would not.
 *
 * A title is the model's job. Where the harness already writes one -- Claude
 * Code names its own threads and records the name in its transcript -- that
 * one is used. Where it does not, the first turn asks for one: twenty
 * characters, on its own line, stripped out of the answer before anyone sees
 * it. A model that ignores the request leaves the chat unnamed and the next
 * turn asks again, which is a better outcome than a name that is really just
 * the first thing the user happened to type.
 */

import type { AiLocalHarnessDefinition } from '../harness/definition.js';
import type { HarnessSession } from './model.js';

/** Long enough to say what a chat is about, short enough to sit on the rule
 * above the composer next to everything else that lives there. */
export const SESSION_TITLE_MAX = 20;

/** `vendor` writes its own title into its own session file and ClikCode reads
 * it; `ask` has no such thing, so the turn asks for one. */
export function sessionTitleSource(harness: AiLocalHarnessDefinition | undefined): 'vendor' | 'ask' {
  return harness?.command === 'claude' ? 'vendor' : 'ask';
}

/** How many turns get an embedded title request before ClikCode stops
 * asking. Retried once past the first turn: a model that ignores it is more
 * often a one-off (a tool call before any text, an odd first prompt) than a
 * standing refusal, and a second try is nearly free. Not retried forever --
 * one that still ignores it twice is telling ClikCode something, and asking
 * on every turn of an otherwise-normal chat would eventually be noise. */
export const TITLE_REQUEST_ATTEMPTS = 2;

/** Whether this turn should carry an embedded title request. */
export function shouldRequestTitle(session: Pick<HarnessSession, 'name' | 'titleAttempts'>): boolean {
  return !session.name && (session.titleAttempts ?? 0) < TITLE_REQUEST_ATTEMPTS;
}

/** Give back the request this turn spent, because the turn stopped being the
 * one that asked. An account switch mid-turn re-drives the vendor's own
 * thread with "carry on" and no longer carries the title request, so no title
 * can arrive -- and a chat that is still unnamed deserves to be asked again
 * on its next turn rather than quietly losing one of its two chances. */
export function refundTitleRequest(session: Pick<HarnessSession, 'titleAttempts'>): void {
  session.titleAttempts = Math.max(0, (session.titleAttempts ?? 1) - 1);
}

const OPEN = '<clikcode-title>';
const CLOSE = '</clikcode-title>';

/** Appended to the first turn of an unnamed chat, and to no other turn. */
function titleRequest(): string {
  return `\n\n${OPEN}Before anything else, on its very first line, reply with `
    + `${OPEN}a title${CLOSE} — at most ${SESSION_TITLE_MAX} characters, naming what this `
    + `conversation is about (not what it literally says). Then answer normally. `
    + `The line is removed before the user sees your reply.${CLOSE}`;
}

export function withTitleRequest(prompt: string): string {
  return `${prompt}${titleRequest()}`;
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

/** The title a reply opens with, and the reply without it. */
export function extractSessionTitle(answer: string): { title?: string; text: string } {
  const match = new RegExp(`^\\s*${OPEN}([\\s\\S]*?)${CLOSE}[ \\t]*\\r?\\n?`).exec(answer);
  if (!match) return { text: answer };
  const title = normalizeSessionTitle(match[1] ?? '');
  const text = answer.slice(match[0].length);
  return { ...(title ? { title } : {}), text };
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

  private couldStillOpen(): boolean {
    const head = this.buffer.replace(/^\s+/, '');
    if (head.length < OPEN.length) return OPEN.startsWith(head);
    return head.startsWith(OPEN) && this.buffer.length < DECIDE_AFTER + OPEN.length;
  }
}
