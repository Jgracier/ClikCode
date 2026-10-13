/** Notes from ClikCode to the model about the machine's resources: that
 * memory is getting tight, or that a command the agent ran was stopped for
 * using too much (worker/resource-guard.ts). For the model only -- the user
 * did not write them and never sees them.
 *
 * A note goes into the running turn at its next pause when the turn can take
 * one (LiveTurnInputBroker.steerNote); otherwise it waits here and rides on
 * the next turn's text, the way a title request does -- never on what is
 * stored as the user's message. A vendor keeps what it was sent, so a note
 * read back out of its transcript is stripped there (stripResourceNotes, in
 * normalizeImportedTranscript). */

const OPEN = '<clikcode_resource_note>';
const CLOSE = '</clikcode_resource_note>';
const LEADING_NOTES = /^(?:\s*<clikcode_resource_note>[\s\S]*?<\/clikcode_resource_note>)+\s*/;

export function wrapResourceNote(text: string): string {
  return `${OPEN}\n${text.trim()}\n${CLOSE}`;
}

/** A user message with any notes it opens with taken off; '' when it was only notes. */
export function stripResourceNotes(content: string): string {
  return content.replace(LEADING_NOTES, '');
}

const pending = new Map<string, string[]>();

/** Held for this conversation's next turn. */
export function holdResourceNote(sessionId: string, note: string): void {
  const notes = pending.get(sessionId) ?? [];
  notes.push(wrapResourceNote(note));
  pending.set(sessionId, notes);
}

/** `turnText` with every held note in front of it; the notes are then gone. */
export function withResourceNotes(sessionId: string, turnText: string): string {
  const notes = pending.get(sessionId);
  if (!notes?.length) return turnText;
  pending.delete(sessionId);
  return `${notes.join('\n')}\n\n${turnText}`;
}
