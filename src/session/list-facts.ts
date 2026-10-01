/** What the conversation list needs, kept on the index so opening the list
 * does not read every transcript.
 *
 * The transcript file is the conversation. The index remembers only enough
 * to draw a row: the last thing asked, whether a turn is in flight, and how
 * many messages there are. Those change when a turn starts, ends, or receives
 * a new user message -- not while an answer is streaming -- so a checkpoint
 * still rewrites one session file and leaves the index alone. */

import { hidden, sameData } from './store/data.js';
import type { HarnessSession } from './model.js';

const TRANSCRIPT_LOADED = Symbol('clikcode.transcriptLoaded');
const FROM_INDEX = Symbol('clikcode.fromIndex');

export interface ListTurn {
  startedAt: string;
  prompt: string;
  subagents?: NonNullable<HarnessSession['pendingTurn']>['subagents'];
}

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
    if (message?.role === 'user' && message.content.trim()) { text = message.content; break; }
  }
  text ??= session.pendingTurn?.prompt;
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
 * row changed. A session whose transcript was not loaded is left alone, so a
 * light read cannot wipe the preview. */
export function stampListFacts(session: HarnessSession): boolean {
  if (!transcriptWasLoaded(session)) return false;
  const preview = previewFromTranscript(session);
  const count = session.messages?.length ?? 0;
  const pending = session.pendingTurn;
  const turn: ListTurn | undefined = pending ? {
    startedAt: pending.startedAt,
    prompt: pending.prompt,
    ...(pending.subagents?.length ? { subagents: pending.subagents.map((agent) => ({ ...agent })) } : {}),
  } : undefined;
  let changed = false;
  if (session.listPreview !== preview) {
    if (preview) session.listPreview = preview;
    else delete session.listPreview;
    changed = true;
  }
  if (!sameData(session.listTurn, turn)) {
    if (turn) session.listTurn = turn;
    else delete session.listTurn;
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

/** The turn the list shows. The live journal when this process has it;
 * otherwise the index copy, with `updatedAt` from the transcript file's
 * mtime so the pace follows the last write without parsing the file. */
export function listedPending(session: HarnessSession, activityAt?: string): HarnessSession['pendingTurn'] | undefined {
  if (session.pendingTurn) return session.pendingTurn;
  const turn = session.listTurn;
  if (!turn) return undefined;
  return {
    prompt: turn.prompt,
    startedAt: turn.startedAt,
    updatedAt: activityAt ?? turn.startedAt,
    outputStarted: false,
    ...(turn.subagents ? { subagents: turn.subagents } : {}),
  };
}

/** Drop index `listTurn` rows that are not a turn still running.
 *
 * The index keeps a short copy so the board can show a spinner without
 * opening every transcript. When a turn ends, that copy is cleared -- but a
 * crash, or a worker that stayed up between turns after a write missed the
 * clear, leaves it behind. The board then animates a chat that is idle.
 * `workerIsLive` is the process check; the transcript is the journal. */
export async function reconcileListTurns(
  sessions: readonly HarnessSession[],
  workerIsLive: (sessionId: string) => boolean,
  readPending: (sessionId: string) => Promise<HarnessSession['pendingTurn'] | undefined>,
): Promise<boolean> {
  let changed = false;
  await Promise.all(sessions.map(async (session) => {
    if (session.pendingTurn || !session.listTurn) return;
    if (!workerIsLive(session.id)) {
      delete session.listTurn;
      changed = true;
      return;
    }
    const pending = await readPending(session.id).catch(() => undefined);
    if (pending) return;
    delete session.listTurn;
    changed = true;
  }));
  return changed;
}


