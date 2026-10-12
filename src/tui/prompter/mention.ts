/** Browsing a /search mention in its conversation: showing it, its keys, and jumping the transcript to it. */
import { stdout as output } from 'node:process';
import type { HarnessSession } from '../../session/model.js';
import { rowOfOccurrence, type MentionFocus } from '../render/search-focus.js';
import { takeTerminalKeys } from '../input-decoder.js';
import { enterInputModes, popReadModes } from '../modes.js';
import type { TerminalHarnessPrompter } from '../prompter.js';

/** /search: show `session` at one mention, its words highlighted and
 * `focus.status` under it. The view moves to the mention on the frame
 * that draws it -- rewriting the conversation from an earlier message
 * first when the mention is older than what is on screen. */
export function showMention(this: TerminalHarnessPrompter, session: HarnessSession, focus: MentionFocus): void {
  this.mentionFocus = { ...focus, sessionId: session.id, jumped: false };
  if (this.currentSession?.id === session.id && !this.messageLines.has(focus.messageIndex)) this.emitted.requestReseed();
  this.render(session);
}

/** The next key while browsing mentions: Up/Down move between them, Tab
 * goes to the next conversation, Esc (or Enter) ends it. Page keys and
 * the wheel still scroll. */
export function mentionKey(this: TerminalHarnessPrompter): Promise<'next' | 'previous' | 'chat' | 'done'> {
  return new Promise((resolve) => {
    let stop: () => void = () => {};
    const listen = (): void => {
      stop = takeTerminalKeys((key) => {
        const action = key === '\u001b[A' ? 'previous' as const : key === '\u001b[B' ? 'next' as const : key === '\t' ? 'chat' as const
          : key === '\u001b' || key === '\r' || key === '\u0003' ? 'done' as const : undefined;
        if (!action) {
          if (key === '\u000c') { this.requestRedraw('repair'); this.forgetScreenPosition(); this.repaint(); return; }
          this.handleScrollKey(key);
          return;
        }
        stop();
        this.resumeInput = undefined;
        output.write(popReadModes());
        resolve(action);
      });
      output.write(enterInputModes());
    };
    this.resumeInput = () => { stop(); listen(); };
    listen();
  });
}

/** Browsing is over: the view stays at the mention, its words stay
 * highlighted until the next line is sent, and the status line goes. */
export function endMention(this: TerminalHarnessPrompter): void {
  if (!this.mentionFocus) return;
  this.mentionFocus = { ...this.mentionFocus, status: undefined };
  this.repaint();
}

/** Puts the mention a few rows below the top of the view, once, on the
 * first frame whose transcript holds it. */
export function jumpToMention(this: TerminalHarnessPrompter, above: number): void {
  const focus = this.mentionFocus;
  if (!focus || focus.jumped || this.currentSession?.id !== focus.sessionId) return;
  const start = this.messageLines.get(focus.messageIndex);
  if (start === undefined) return;
  const from = start - this.alternateTrimmed;
  if (from < 0 || from >= this.alternateTranscript.length) return;
  const nextStart = this.messageLines.get(focus.messageIndex + 1);
  const to = nextStart === undefined ? this.alternateTranscript.length : Math.min(this.alternateTranscript.length, nextStart - this.alternateTrimmed);
  const found = focus.words[0] ? rowOfOccurrence(this.alternateTranscript.slice(from, to), focus.words[0], focus.occurrence) : undefined;
  const row = from + (found ?? 0);
  const first = Math.max(0, row - 3);
  this.alternateScrollback = Math.max(0, this.alternateTranscript.length - above - first);
  focus.jumped = true;
}
