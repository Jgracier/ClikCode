import { describe, expect, it } from 'vitest';
import { nextInlineChoice } from './option-picker.js';

const two = [{ value: 'auto' }, { value: 'never' }];
const three = [{ value: 'ask' }, { value: 'bypass' }, { value: 'auto' }];

describe('switching a setting in place', () => {
  it('flips between two', () => {
    expect(nextInlineChoice(two, 'auto').value).toBe('never');
    expect(nextInlineChoice(two, 'never').value).toBe('auto');
  });

  it('cycles through a few, wrapping', () => {
    expect(nextInlineChoice(three, 'ask').value).toBe('bypass');
    expect(nextInlineChoice(three, 'auto').value).toBe('ask');
  });

  it('moves a value that is no longer offered to the first choice', () => {
    expect(nextInlineChoice(three, 'xhigh').value).toBe('ask');
  });
});
