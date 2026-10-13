/** Notes: panels and notices placed where they happened. */
import { noticeLevel } from '../text';
import { takeSeq } from './activity';
import type { ChatModel, Note } from './types';


export const MAX_NOTES = 50;

/** A note goes where it happened: during a turn, after the prompt that
 * started it (the prompt is not in the transcript yet), else at the end. */
export function withNote(model: ChatModel, note: Omit<Note, 'after'>): ChatModel {
  const during = model.running && model.turnUserIndex !== undefined;
  const after = during ? model.turnUserIndex! + 1 : model.messages.length;
  // Mid-turn it is also placed in the turn: at the answer offset where it
  // arrived, in order among the rows, so it neither trails the live turn nor
  // jumps above the answer when the turn ends (standard sections 1, 11).
  const live = during ? model.live : undefined;
  // Where the worker placed it, when it said (WorkerEvent `note`).
  const taken = live ? takeSeq(live, note.seq) : undefined;
  const placed: Note = {
    ...note, after,
    ...(live ? { turn: model.turnUserIndex!, offset: Math.min(note.offset ?? live.text.length, live.text.length), seq: taken!.seq } : {}),
  };
  return {
    ...model, ...(live ? { live: { ...live, seen: taken!.seen } } : {}),
    notes: [...model.notes, placed].slice(-MAX_NOTES),
  };
}

/** The turn's notices the worker kept, added to the window's own as notes at
 * their offsets. One the window already has -- the same mark, the same seq, or
 * the same words at the same place -- is not added again. */
export function withNoticeMarks(notes: Note[], turn: number, notices: Array<{ id: string; text: string; offset: number; seq: number }>): Note[] {
  const fresh = notices.filter((notice) => !notes.some((note) => note.turn === turn
    && (note.markId === notice.id || note.seq === notice.seq || (note.text === notice.text && note.offset === notice.offset))));
  if (!fresh.length) return notes;
  return [...notes, ...fresh.map((notice): Note => ({
    kind: 'notice', level: noticeLevel(notice.text), text: notice.text, after: turn + 1, turn, offset: notice.offset, seq: notice.seq, markId: notice.id,
  }))].slice(-MAX_NOTES);
}
