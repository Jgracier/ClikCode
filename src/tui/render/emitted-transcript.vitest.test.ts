/** The scrollback record, tested for the first time.
 *
 * These seven rules were seven fields in prompter.ts, mutated from six places
 * inside a 480-line paint(), with nothing covering any of them. Two of them
 * have already cost something in production: a message vanished, and a
 * response appeared twice. The transcript is the terminal's own scrollback,
 * so neither could be taken back.
 */
import { describe, expect, it } from 'vitest';
import { EmittedTranscript } from './emitted-transcript';

const user = (content: string) => ({ role: 'user', content });
const assistant = (content: string) => ({ role: 'assistant', content });

/** Writes a whole list the way paint() does, so resume() can be asked what it
 *  would do on the next frame. */
function writeAll(record: EmittedTranscript, messages: readonly { role: string; content: string }[]): void {
  for (const message of messages) record.wrote(message);
  record.settle(messages.length);
}

describe('what has already been written to scrollback', () => {
  it('resumes at the end of what it wrote, so nothing is drawn twice', () => {
    const record = new EmittedTranscript();
    const conversation = [user('q'), assistant('a')];
    writeAll(record, conversation);
    expect(record.resume(conversation).firstUnwritten).toBe(2);
  });

  it('resumes correctly when the next frame hands back only a WINDOW', () => {
    // The failure: the turn is handed messages.slice(-40), so mid-conversation
    // the list is a window. A count alone starts past its end and writes
    // nothing -- the message just submitted included, which vanished as the
    // answer to it streamed in underneath.
    const record = new EmittedTranscript();
    writeAll(record, Array.from({ length: 57 }, (_, i) => user(`m${i}`)));
    const window = [user('m55'), user('m56'), user('just submitted')];
    expect(record.resume(window).firstUnwritten).toBe(2);
  });

  it('never lowers its count when a list comes back shorter', () => {
    // sessionTranscriptMessages materializes a pending turn; the live form of
    // the same turn does not. If the count dropped, the seam would walk
    // backwards and rewrite what is already on screen.
    const record = new EmittedTranscript();
    record.settle(9);
    record.settle(4);
    expect(record.writtenCount()).toBe(9);
  });

  it('reports a materialized pending turn, so live steers are dropped instead of doubled', () => {
    const record = new EmittedTranscript();
    record.settle(5);
    // Nothing written identifies the seam, and the list is shorter than what
    // was retired: its steers are already in scrollback as real messages.
    expect(record.resume([user('a'), user('b'), user('c')]).materializedPendingTurn).toBe(true);
  });

  it('finds the live answer even after the user message shifted it down', () => {
    // The failure: the index is recorded as the list length while streaming,
    // then the user's own message lands in that same list. The recorded index
    // points at the USER message and the answer is drawn a SECOND time.
    const record = new EmittedTranscript();
    record.liveAssistantIndex = 1;
    expect(record.resume([assistant('old'), user('q'), assistant('answer')]).liveAssistant).toBe(2);
  });

  it('claims each activity row once, by identity and not by text', () => {
    const record = new EmittedTranscript();
    expect(record.claimActivity(7)).toBe(true);
    expect(record.claimActivity(7)).toBe(false);
    // Two rows that say the same thing are still two rows.
    expect(record.claimActivity(8)).toBe(true);
    // Nothing to claim without an identity.
    expect(record.claimActivity(undefined)).toBe(false);
  });

  it('retires user messages so a steer is not drawn beside its own real copy', () => {
    const record = new EmittedTranscript();
    record.wrote(user('try the other file'));
    record.wrote(assistant('done'));
    expect(record.wasRetired('try the other file')).toBe(true);
    // Only the user's own words are retired; an answer is never a steer.
    expect(record.wasRetired('done')).toBe(false);
  });

  it('asks for a blank screen only when something is already above it', () => {
    const first = new EmittedTranscript();
    first.requestReseed();
    expect(first.pendingReseed()).toBe('first');

    const returning = new EmittedTranscript();
    returning.settle(3);
    returning.requestReseed();
    expect(returning.pendingReseed()).toBe('scroll-away');
  });

  it('starts from nothing after a reseed, so the WHOLE conversation is rewritten', () => {
    // Writing only the last forty is why a chat opened from disk could not be
    // scrolled back through: the rows were never there to find.
    const record = new EmittedTranscript();
    const conversation = [user('q'), assistant('a')];
    writeAll(record, conversation);
    record.liveAssistantIndex = 1;
    record.requestReseed();

    record.reseeded();
    expect(record.pendingReseed()).toBe(false);
    expect(record.writtenCount()).toBe(0);
    expect(record.resume(conversation).firstUnwritten).toBe(0);
    expect(record.wasRetired('q')).toBe(false);
    expect(record.claimActivity(7)).toBe(true);
    expect(record.liveAssistantIndex).toBeUndefined();
  });

  it('starts a fresh session already owing a reseed, before anything is written', () => {
    expect(new EmittedTranscript().pendingReseed()).toBe('first');
  });
});
