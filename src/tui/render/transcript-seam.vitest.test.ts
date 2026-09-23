/** The three seam decisions, each written as the failure it prevents.
 *
 * All three lived inline in prompter.paint() with no tests, and all three
 * have been wrong in production: a message vanished, a response was drawn
 * twice. The transcript is the terminal's own scrollback, so neither can be
 * taken back once written.
 */
import { describe, expect, it } from 'vitest';
import {
  firstUnwritten, liveAssistantAt, materializedPendingTurn, messageKey,
} from './transcript-seam';

const user = (content: string) => ({ role: 'user', content });
const assistant = (content: string) => ({ role: 'assistant', content });

describe('where the transcript resumes', () => {
  it('resumes after the last message actually written', () => {
    const persisted = [user('one'), assistant('two'), user('three')];
    expect(firstUnwritten(persisted, 2, messageKey(assistant('two')))).toBe(2);
  });

  it('finds the seam inside a WINDOW, which a count alone cannot', () => {
    // The real bug: the turn is handed messages.slice(-40), so mid-conversation
    // the array is a window. Counting absolutely (emitted=57) starts past the
    // end and writes NOTHING -- the message just submitted included, which
    // vanished as the answer to it streamed in underneath.
    const window = [user('older'), assistant('answer'), user('just submitted')];
    expect(firstUnwritten(window, 57, messageKey(assistant('answer')))).toBe(2);
  });

  it('searches from the end, so a repeated sentence does not rewind the transcript', () => {
    // "ok" said twice: matching the FIRST would re-emit everything after it.
    const persisted = [user('ok'), assistant('sure'), user('ok'), assistant('again')];
    expect(firstUnwritten(persisted, 4, messageKey(user('ok')))).toBe(3);
  });

  it('falls back to the count when nothing has been written yet', () => {
    expect(firstUnwritten([user('a'), user('b')], 1, undefined)).toBe(1);
  });

  it('never resumes past the end of the list it was given', () => {
    expect(firstUnwritten([user('a')], 9, undefined)).toBe(1);
  });

  it('falls back to the count when the remembered message is no longer present', () => {
    // Compaction can drop it; resuming from 0 would redraw the conversation.
    expect(firstUnwritten([user('a'), user('b')], 2, 'user:long gone')).toBe(2);
  });
});

describe('whether the pending turn is already in the transcript', () => {
  it('is true when more was retired than this list holds and the seam is its end', () => {
    expect(materializedPendingTurn(3, 3, 5)).toBe(true);
  });

  it('is false while there is still something unwritten', () => {
    expect(materializedPendingTurn(2, 3, 5)).toBe(false);
  });

  it('is false when no more was retired than the list holds', () => {
    expect(materializedPendingTurn(3, 3, 3)).toBe(false);
  });
});

describe('where the streamed answer landed', () => {
  it('finds the assistant at the recorded index', () => {
    expect(liveAssistantAt([user('q'), assistant('a')], 1)).toBe(1);
  });

  it('walks forward when the user message shifted the answer down', () => {
    // The real bug: the index is recorded as the list length while streaming,
    // then the user's own message is materialized into that same list. The
    // recorded index points at the USER message, the role check fails, and the
    // answer is drawn a SECOND time under the copy already on screen.
    expect(liveAssistantAt([assistant('old'), user('q'), assistant('the answer')], 1)).toBe(2);
  });

  it('runs off the end rather than pointing at the wrong message', () => {
    // Nothing persisted yet: the caller's role check must simply not match.
    const persisted = [user('q')];
    expect(liveAssistantAt(persisted, 0)).toBe(persisted.length);
  });

  it('stays undefined when no answer was streaming', () => {
    expect(liveAssistantAt([user('q'), assistant('a')], undefined)).toBeUndefined();
  });
});
