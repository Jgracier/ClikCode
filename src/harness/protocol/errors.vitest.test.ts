import { describe, expect, it } from 'vitest';
import { errorText, userError } from './errors';

describe('a failure, put to a person', () => {
  it('says what could not be done, then why', () => {
    expect(userError('copy', new Error('permission denied.'))).toBe('Could not copy: permission denied');
    expect(userError('open a.ts', 'gone')).toBe('Could not open a.ts: gone');
    expect(userError('undo the change to a.ts')).toBe('Could not undo the change to a.ts.');
  });

  it('reads any thrown value', () => {
    expect([new Error('x'), 'y', 3].map(errorText)).toEqual(['x', 'y', '3']);
  });
});
