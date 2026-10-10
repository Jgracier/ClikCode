/** What the conversation list needs, kept on the index so opening the list
 * does not read every transcript.
 *
 * The transcript file is the conversation. The index remembers only enough
 * to draw a row: the last thing asked and how many messages there are. Those
 * change when a user message lands -- not while an answer is streaming -- so a
 * checkpoint still rewrites one session file and leaves the index alone.
 *
 * Whether a turn is in flight is NOT copied here: that is the transcript's
 * `pendingTurn`, read for live-worker sessions only (livePendingTurns). An
 * older build stored a `listTurn` copy on the row; it is ignored, and
 * dropped the next time the row is summarized. */

import { hidden } from './store/data.js';
import { isClikCodeNotice } from './clikcode-notice.js';
import type { HarnessSession } from './model.js';

const TRANSCRIPT_LOADED = Symbol('clikcode.transcriptLoaded');
const FROM_INDEX = Symbol('clikcode.fromIndex');

export function markTranscriptLoaded(session: HarnessSession): void {
  hidden(session, TRANSCRIPT_LOADED, true);
}

export function transcriptWasLoaded(session: HarnessSession): boolean {
  return Boolean((session as { [TRANSCRIPT_LOADED]?: boolean })[TRANSCRIPT_LOADED]);
}

export function markFromIndex(session: HarnessSession): void {
  hidden(session, FROM_INDEX, true);
}

export function sessionFromIndex(session: HarnessSession): boolean {
  return Boolean((session as { [FROM_INDEX]?: boolean })[FROM_INDEX]);
}

function previewFromTranscript(session: HarnessSession, limit = 48): string | undefined {
  const messages = session.messages ?? [];
  let text: string | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    // A notice ClikCode sent in the user's place is not something they asked.
    if (message?.role === 'user' && message.content.trim() && !isClikCodeNotice(message.content)) { text = message.content; break; }
  }
  const pending = session.pendingTurn?.prompt;
  if (pending && !isClikCodeNotice(pending)) text ??= pending;
  if (!text?.trim()) return undefined;
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/** The last thing the user asked. From the transcript when this process has
 * it, otherwise the line the index remembered. */
export function conversationPreview(session: HarnessSession, limit = 48): string | undefined {
  if (!transcriptWasLoaded(session) && session.messages === undefined && session.pendingTurn === undefined) return session.listPreview;
  return previewFromTranscript(session, limit);
}

/** Copy the row's facts off a loaded transcript. Returns whether the index
 * row changed. A row read from the index without its transcript is left
 * alone, so a light read cannot wipe the preview; one made in this process
 * (a new chat, a fork, /redo's archived copy) holds its whole transcript, so
 * it is summarized on its first write. */
export function stampListFacts(session: HarnessSession): boolean {
  if (!transcriptWasLoaded(session) && (sessionFromIndex(session) || session.messages === undefined)) return false;
  const preview = previewFromTranscript(session);
  const count = session.messages?.length ?? 0;
  let changed = false;
  if (session.listPreview !== preview) {
    if (preview) session.listPreview = preview;
    else delete session.listPreview;
    changed = true;
  }
  const legacy = session as { listTurn?: unknown };
  if (legacy.listTurn !== undefined) {
    delete legacy.listTurn;
    changed = true;
  }
  if (session.listMessageCount !== count) {
    session.listMessageCount = count;
    changed = true;
  }
  if (!session.listChecked) {
    session.listChecked = true;
    changed = true;
  }
  return changed;
}
