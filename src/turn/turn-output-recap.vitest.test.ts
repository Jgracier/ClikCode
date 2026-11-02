import { describe, expect, it } from 'vitest';
import { turnSink } from './turn-output.js';

describe('turnSink and a recap line under the answer', () => {
  it('takes the line off the screen and the checkpoint once it is whole', () => {
    const screen: Array<[string, string]> = [];
    const saved: Array<[string, string]> = [];
    const sink = turnSink(
      { response: (text: string, mode = 'append') => { saved.push([text, mode]); }, activity: () => {} } as never,
      { response: (text: string, mode = 'append') => { screen.push([text, mode]); } } as never,
    );
    sink.response('Done.\n\n');
    sink.response('[Did: $ npm test · and 5 more]');
    expect(screen.at(-1)).toEqual(['Done.', 'replace']);
    expect(saved.at(-1)).toEqual(['[Did: $ npm test · and 5 more]', 'append']);
    sink.response('\nMore.');
    expect(screen.at(-1)).toEqual(['\nMore.', 'append']);
  });
});
