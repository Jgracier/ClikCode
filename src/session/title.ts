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
 * it. A model that ignores the one request leaves the chat unnamed.
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

/** Only the first meaningful turn gets an embedded title request. The request
 * is spent whether or not the model returns a title; continued conversations
 * must never be prompted for a title again. */
export const TITLE_REQUEST_ATTEMPTS = 1;

/** Whether this turn should carry an embedded title request. */
export function shouldRequestTitle(session: Pick<HarnessSession, 'name' | 'titleAttempts'>): boolean {
  return !session.name && (session.titleAttempts ?? 0) < TITLE_REQUEST_ATTEMPTS;
}

/** Spend the conversation's single title request on this turn, if eligible. */
export function prepareSessionTitle(
  session: Pick<HarnessSession, 'name' | 'titleAttempts'>, prompt: string,
): { prompt: string; stream: StreamingTitle } {
  // Every turn's reply goes through a title stream. Only the turn that asked
  // keeps the title it finds; on every other turn the stream just strips one.
  // A vendor harness keeps its whole history, so a model that opened its first
  // reply with the tag tends to open later replies with it too -- unasked --
  // and without this that tag went straight to the screen.
  if (!shouldRequestTitle(session)) return { prompt, stream: new StreamingTitle({ naming: false }) };
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
  session: Pick<HarnessSession, 'titleAttempts'>,
): StreamingTitle {
  if (current?.title) return current;
  if (promptAsksForTitle(prompt)) {
    if (current?.naming) {
      current.restart();
      return current;
    }
    return new StreamingTitle();
  }
  // The request was already sent on the original attempt. A retry that replaces
  // it must not make the next user turn ask for a title again -- but the reply
  // may still open with a tag, which is stripped, not kept.
  if (current && !current.naming) {
    current.restart();
    return current;
  }
  return new StreamingTitle({ naming: false });
}

const OPEN = '<clikcode-title>';
const CLOSE = '</clikcode-title>';

/** Appended to the first turn of an unnamed chat, and to no other turn. */
function titleRequest(): string {
  return `\n\n${OPEN}Before anything else, on its very first line, reply with `
    + `${OPEN}a title${CLOSE} — at most ${SESSION_TITLE_MAX} characters, naming what this `
    + `conversation is about (not what it literally says). Then answer normally. `
    + `The line is removed before the user sees your reply. This is asked once: `
    + `do this in this reply only, and never start any later reply with a title.${CLOSE}`;
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
/** A model that drops the tags but keeps the word: `Title: …` (or
 * `**Title:** …`) on the first line. Explicit enough to remove. */
const PLAIN_TITLE = /^\s*(?:\*\*)?title:(?:\*\*)?[ \t]*([^\r\n]+?)(?:\*\*)?[ \t]*\r?\n(?:[ \t]*\r?\n)?/i;

export function extractSessionTitle(answer: string): { title?: string; text: string } {
  const match = new RegExp(`^\\s*${OPEN}([\\s\\S]*?)${CLOSE}[ \\t]*\\r?\\n?`).exec(answer) ?? PLAIN_TITLE.exec(answer);
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
  /** False on turns that did not ask for a title: the tag is still stripped
   * from the reply, but what it said is not this chat's name. */
  readonly naming: boolean;

  constructor(options: { naming?: boolean } = {}) {
    this.naming = options.naming ?? true;
  }

  /** The title, once the stream has produced one (only on the turn that asked). */
  get title(): string | undefined { return this.naming ? this.found : undefined; }

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

  private couldStillOpen(): boolean {
    const head = this.buffer.replace(/^\s+/, '');
    // `Title: …` is settled by its line ending; until then it may be one.
    const plain = head.replace(/^\*\*/, '').toLowerCase();
    if (plain.length < 'title:'.length ? 'title:'.startsWith(plain) : plain.startsWith('title:') && !/\r?\n/.test(head)) {
      return this.buffer.length < DECIDE_AFTER + OPEN.length;
    }
    if (head.length < OPEN.length) return OPEN.startsWith(head);
    return head.startsWith(OPEN) && this.buffer.length < DECIDE_AFTER + OPEN.length;
  }
}
