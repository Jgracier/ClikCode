/** A steer reaches the transcript from two sources; only one may be drawn.
 *
 * This decision was inline in prompter.paint() and untested, which is how the
 * duplicated response happened in the same file: a row drawn from two sources
 * reads as the user having said it twice, and an append-only transcript
 * cannot take it back.
 */
import { describe, expect, it } from 'vitest';
import { enterAgainSends, hasDurableSteer, liveTurnSpan, steerTranscriptRows, type LiveSubmission } from './steer-rows';

const render = (text: string) => [`row:${text}`];
const live = (text: string, sequence: number, state: LiveSubmission['state'] = 'steered'): LiveSubmission =>
  ({ text, sequence, responseOffset: sequence, state });
const rows = (input: Partial<Parameters<typeof steerTranscriptRows>[0]>) => steerTranscriptRows({
  durable: [], live: [], materializedPendingTurn: false, retiredThisSession: new Set(), render, ...input,
});

describe('which steers reach the transcript', () => {
  it('replaces a provisional queued row when the same submission lands as a steer', () => {
    expect(hasDurableSteer({ id: 'a', text: 'same' }, [{ id: 'a', text: 'same' }])).toBe(true);
    expect(hasDurableSteer({ id: 'b', text: 'same' }, [{ id: 'a', text: 'same' }])).toBe(false);
  });
  it('draws a live steer once, before the turn is materialized', () => {
    expect(rows({ live: [live('try the other file', 7)] })).toEqual([
      { id: 'steer#7', done: true, responseOffset: 7, lines: ['row:try the other file'], steer: true, text: 'try the other file' },
    ]);
  });

  it('draws a durable steer once, and drops the live copy of the same text', () => {
    // The double-draw this exists to prevent.
    const result = rows({ durable: [{ text: 'same words', responseOffset: 3 }], live: [live('same words', 9)] });
    expect(result).toHaveLength(1);
    // Under the live copy's id, not a new one: a row is retired once, by id,
    // and the live copy may be retired already when the durable one arrives
    // (changed: this asserted the id the durable copy had when it did not know
    // the live one -- which drew the steer again).
    expect(result[0]!.id).toBe('steer#9');
    expect(result[0]!.responseOffset).toBe(3);
  });

  it('gives two durable steers that say the same thing their own live ids', () => {
    const result = rows({
      durable: [{ text: 'again', responseOffset: 2 }, { text: 'again', responseOffset: 8 }],
      live: [live('again', 4), live('again', 6)],
    });
    expect(result.map((row) => row.id)).toEqual(['steer#4', 'steer#6']);
  });

  it('drops the durable side entirely once the pending turn is materialized', () => {
    // They arrive as real user messages then, so drawing them here too would
    // double every one of them.
    const result = rows({ durable: [{ text: 'a' }, { text: 'b' }], materializedPendingTurn: true });
    expect(result).toEqual([]);
  });

  it('drops a live steer already retired this session, but only after materialization', () => {
    const retired = new Set(['old steer']);
    expect(rows({ live: [live('old steer', 1)], materializedPendingTurn: true, retiredThisSession: retired })).toEqual([]);
    // Before materialization the live copy is the ONLY copy, so retirement by
    // text must not suppress it.
    expect(rows({ live: [live('old steer', 1)], retiredThisSession: retired })).toHaveLength(1);
  });

  it('keeps two distinct steers that happen to say the same thing, before materialization', () => {
    // Identity, not text: saying the same thing twice is still two steers.
    expect(rows({ live: [live('again', 1), live('again', 2)] })).toHaveLength(2);
  });

  it('ignores submissions that are not steers', () => {
    expect(rows({ live: [live('queued up', 1, 'queued'), live('failed', 2, 'error'), live('in flight', 3, 'sending')] })).toEqual([]);
  });

  it('keeps durable steers before live ones, so the transcript stays in order', () => {
    const result = rows({ durable: [{ text: 'first', responseOffset: 1 }], live: [live('second', 5)] });
    expect(result.map((row) => row.lines[0])).toEqual(['row:first', 'row:second']);
  });

  it('defaults a durable steer with no offset to 0 rather than dropping it', () => {
    expect(rows({ durable: [{ text: 'no offset' }] })).toEqual([
      { id: 'steer#0#0', done: true, responseOffset: 0, lines: ['row:no offset'], steer: true, text: 'no offset' },
    ]);
  });

  it('matches a live steer to its durable copy by identity, not by its words', () => {
    // "yes" sent twice is two steers. Matched by text, the second was hidden
    // behind the first one's durable copy.
    const result = rows({
      durable: [{ text: 'yes', responseOffset: 1, id: 'a' }],
      live: [{ ...live('yes', 5), id: 'a' }, { ...live('yes', 6), id: 'b' }],
    });
    expect(result.map((row) => row.lines[0])).toEqual(['row:yes', 'row:yes']);
  });

  it('hides the live copy once its durable one, with the same id, has landed', () => {
    const result = rows({ durable: [{ text: 'check tests', responseOffset: 1, id: 'a' }], live: [{ ...live('check tests', 5), id: 'a' }] });
    expect(result).toHaveLength(1);
  });
});

describe('Enter again on a waiting message', () => {
  it('sends the oldest when it is only queued', () => {
    expect(enterAgainSends([{}, { held: true }])).toBe(true);
  });
  it('offers nothing when the turn already holds it for its next pause: the worker only answers "queued"', () => {
    expect(enterAgainSends([{ held: true }, {}])).toBe(false);
  });
  it('offers nothing when this turn could not take a message: it would only queue again', () => {
    expect(enterAgainSends([{ unsteered: true }])).toBe(false);
    expect(enterAgainSends([{}, { unsteered: true }])).toBe(false);
  });
  it('offers nothing with nothing waiting', () => {
    expect(enterAgainSends([])).toBe(false);
  });
});

describe('where a steer sits among the rows around it', () => {
  it('is placed at its acknowledgement, not at where it was typed', () => {
    const [row] = rows({ live: [{ ...live('now', 3), responseOffset: 3, ack: { sequence: 20, responseOffset: 90 } }] });
    expect(row).toMatchObject({ id: 'steer#3', responseOffset: 90, seq: 20 });
  });

  it('sorts rows that began before the acknowledgement above it and later ones below', async () => {
    const { TurnTranscript } = await import('../../turn/transcript');
    const [steer] = rows({ live: [{ ...live('steer', 1), ack: { sequence: 10, responseOffset: 0 } }] });
    const tool = (id: string, seq: number) => ({ id, done: true, responseOffset: 0, seq, lines: [id] });
    const step = new TurnTranscript().advance({
      content: '', tools: [steer!, tool('after', 11), tool('before', 9)], turnEnded: false, renderBlocks: () => [],
    });
    expect(step.finished).toEqual(['before', 'row:steer', 'after']);
  });
});

describe('which saved messages a live turn already drew', () => {
  const messages = (...items: Array<[string, string, string?]>) => items.map(([role, content, id]) => ({ role, content, ...(id ? { id } : {}) }));

  it('owns the steers it drew and the answer after each', () => {
    const saved = messages(['user', 'go'], ['assistant', 'Step one'], ['user', 'then this'], ['assistant', ' job.\n\nStep two.']);
    expect(liveTurnSpan(saved, 1, [{ text: 'then this' }])).toBe(3);
  });

  it('matches by id where both carry one, so same words are still two steers', () => {
    const saved = messages(['assistant', 'A'], ['user', 'same', 'x1'], ['assistant', 'B'], ['user', 'same', 'x2'], ['assistant', 'C']);
    expect(liveTurnSpan(saved, 0, [{ text: 'same', steerId: 'x1' }])).toBe(2);
    expect(liveTurnSpan(saved, 0, [{ text: 'same', steerId: 'x1' }, { text: 'same', steerId: 'x2' }])).toBe(4);
  });

  it('stops at a user message it never drew: that is the next turn', () => {
    const saved = messages(['assistant', 'A'], ['user', 'next question'], ['assistant', 'B']);
    expect(liveTurnSpan(saved, 0, [{ text: 'something else' }])).toBe(0);
  });

  it('owns a trailing steer that nothing followed', () => {
    const saved = messages(['assistant', 'A'], ['user', 'last word']);
    expect(liveTurnSpan(saved, 0, [{ text: 'last word' }])).toBe(1);
  });
});
