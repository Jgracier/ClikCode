/** A steer reaches the transcript from two sources; only one may be drawn.
 *
 * This decision was inline in prompter.paint() and untested, which is how the
 * duplicated response happened in the same file: a row drawn from two sources
 * reads as the user having said it twice, and an append-only transcript
 * cannot take it back.
 */
import { describe, expect, it } from 'vitest';
import { steerTranscriptRows, type LiveSubmission } from './steer-rows';

const render = (text: string) => [`row:${text}`];
const live = (text: string, sequence: number, state: LiveSubmission['state'] = 'steered'): LiveSubmission =>
  ({ text, sequence, responseOffset: sequence, state });
const rows = (input: Partial<Parameters<typeof steerTranscriptRows>[0]>) => steerTranscriptRows({
  durable: [], live: [], materializedPendingTurn: false, retiredThisSession: new Set(), render, ...input,
});

describe('which steers reach the transcript', () => {
  it('draws a live steer once, before the turn is materialized', () => {
    expect(rows({ live: [live('try the other file', 7)] })).toEqual([
      { id: 'steer#7', done: true, responseOffset: 7, lines: ['row:try the other file'] },
    ]);
  });

  it('draws a durable steer once, and drops the live copy of the same text', () => {
    // The double-draw this exists to prevent.
    const result = rows({ durable: [{ text: 'same words', responseOffset: 3 }], live: [live('same words', 9)] });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('steer#3#0');
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
      { id: 'steer#0#0', done: true, responseOffset: 0, lines: ['row:no offset'] },
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

