import { describe, expect, it } from 'vitest';
import { editWaitingComposer } from './composer-edit';

const BACKSPACE = '\u007f';

describe('a shell line', () => {
  it('opens with a space after `!`, typing where it reads', () => {
    expect(editWaitingComposer('', 0, '!')).toEqual({ value: '! ', cursor: 2, changed: true });
  });

  it('takes `!` as itself anywhere but the start of an empty composer', () => {
    expect(editWaitingComposer('hi', 2, '!')).toEqual({ value: 'hi!', cursor: 3, changed: true });
  });

  it('loses both on Backspace with nothing typed after', () => {
    expect(editWaitingComposer('! ', 2, BACKSPACE)).toEqual({ value: '', cursor: 0, changed: true });
  });

  it('is edited as text once a command is typed', () => {
    expect(editWaitingComposer('! l', 3, BACKSPACE)).toEqual({ value: '! ', cursor: 2, changed: true });
    expect(editWaitingComposer('! ls', 4, BACKSPACE)).toEqual({ value: '! l', cursor: 3, changed: true });
  });
});
