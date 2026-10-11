import { describe, expect, it } from 'vitest';
import { joinedAnswerText } from './live-answer.js';

describe('the answer a joining window starts from', () => {
  it('takes the live copy while the journal (written on a debounce) is behind it', () => {
    expect(joinedAnswerText('The parser has two', 'The parser has two passes and')).toBe('The parser has two passes and');
  });

  it('takes the durable copy once it is at least as long', () => {
    expect(joinedAnswerText('The parser has two passes.', 'The parser has two')).toBe('The parser has two passes.');
    expect(joinedAnswerText('same', 'same')).toBe('same');
  });

  it('is the same whichever copy is read first, and either may be missing', () => {
    const pairs: Array<[string | undefined, string | undefined]> = [['a', 'abc'], ['abc', 'a'], [undefined, 'x'], ['x', undefined], [undefined, undefined]];
    for (const [durable, live] of pairs) {
      expect(joinedAnswerText(durable, live)).toBe(joinedAnswerText(durable, live));
    }
    expect(joinedAnswerText(undefined, 'x')).toBe('x');
    expect(joinedAnswerText('x', undefined)).toBe('x');
    expect(joinedAnswerText(undefined, undefined)).toBe('');
  });
});
