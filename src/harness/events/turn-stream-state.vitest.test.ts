/** A turn's stream position belongs to the turn, not to whatever `session_id`
 * a vendor happens to put on some of its records. */
import { describe, expect, it } from 'vitest';
import { createStreamState, nativeResponseUpdate } from './adapters.js';
import type { AiLocalHarnessDefinition } from '../definition.js';

const cmdc = { command: 'command', parser: 'generic-json', turn: { output: 'json-lines' } } as unknown as AiLocalHarnessDefinition;
const line = (record: unknown): string => JSON.stringify(record);
const text = (value: string) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: value }] } });

/** Everything one turn would put on screen, in order. */
function shown(records: string[]): string {
  const turn = createStreamState();
  return records.map((record) => nativeResponseUpdate(cmdc, record, turn)?.text ?? '').join('');
}

describe('one turn\'s stream', () => {
  it('does not show the final result again when only it carries a session id', () => {
    // The bug: text records without a session_id, a result with one. Keyed by
    // session id, the result looked like the first text of a fresh stream,
    // and the answer was saved as "...live.The final commit is live."
    const output = shown([
      text('Checking the workspace first.'),
      text('The final commit is live.'),
      line({ type: 'result', session_id: 'abc', result: 'The final commit is live.' }),
    ]);
    expect(output.match(/The final commit is live\./g)).toHaveLength(1);
  });

  it('breaks the paragraph between two whole messages', () => {
    expect(shown([text('Checking the workspace first.'), text('The final commit is live.')]))
      .toBe('Checking the workspace first.\n\nThe final commit is live.');
  });

  it('shows the result when it is the only thing that carried the answer', () => {
    expect(shown([line({ type: 'result', session_id: 'abc', result: 'Done.' })])).toBe('Done.');
  });

  it('starts clean each turn -- nothing from the last one carries over', () => {
    // No init record on this stream, so nothing reset the old keyed state:
    // the next turn's result was suppressed and its first text got a break.
    shown([text('First turn answer.')]);
    expect(shown([text('Second turn answer.')])).toBe('Second turn answer.');
    expect(shown([line({ type: 'result', result: 'Only a result this time.' })])).toBe('Only a result this time.');
  });
});
