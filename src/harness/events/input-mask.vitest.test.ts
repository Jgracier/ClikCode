import { describe, expect, it } from 'vitest';
import { applyInputMask, maskComplete, maskPattern } from './input-mask.js';

const type = (pattern: string, keys: string): string => [...keys].reduce((shown, key) => applyInputMask(shown + key, pattern), '');

describe('input masks', () => {
  it('types a date by itself: 06 jumps the slash, 18 jumps the next, 1998 completes it', () => {
    const date = maskPattern('date')!;
    expect(type(date, '06')).toBe('06/');
    expect(type(date, '0618')).toBe('06/18/');
    expect(type(date, '06181998')).toBe('06/18/1998');
    expect(type(date, '06/18/1998')).toBe('06/18/1998');
    expect(type(date, '0618199899')).toBe('06/18/1998');
    expect(maskComplete('06/18/1998', date)).toBe(true);
    expect(maskComplete('06/18/19', date)).toBe(false);
  });
  it('types a phone number by itself', () => {
    const phone = maskPattern('phone')!;
    expect(type(phone, '7')).toBe('(7');
    expect(type(phone, '719')).toBe('(719) ');
    expect(type(phone, '7197443850')).toBe('(719) 744-3850');
    expect(type(phone, '+1 (719) 744-3850'.replace('+1 ', ''))).toBe('(719) 744-3850');
  });
  it('ignores keys the next slot does not take', () => {
    expect(type('##/##', 'ab1x2')).toBe('12/');
  });
  it('lets Backspace get past a literal', () => {
    const date = maskPattern('date')!;
    expect(applyInputMask('06/1', date, true)).toBe('06/1');
    expect(applyInputMask('06/', date, true)).toBe('06');
    expect(applyInputMask('(719) ', maskPattern('phone')!, true)).toBe('(719');
  });
  it('takes a custom pattern and refuses a non-pattern', () => {
    expect(maskPattern('AA-####')).toBe('AA-####');
    expect(maskPattern('whatever')).toBeUndefined();
    expect(type('AA-####', 'ab1234')).toBe('ab-1234');
  });
});
