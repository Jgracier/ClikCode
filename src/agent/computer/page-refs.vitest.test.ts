import { describe, expect, it } from 'vitest';
import { REF, refNames } from './page-refs.js';

describe('refNames', () => {
  it('reads the role and name beside every reference a page view shows', () => {
    const names = refNames([
      '- generic [ref=e1]:',
      '  - button "Save and continue" [ref=e12] [cursor=pointer]',
      '  - combobox "Country" [expanded] [ref=f8e383]',
      '  - \'button "Play: the \\"intro\\" video" [ref=e179]\'',
      '  - text: no reference here',
      '  - option "It\'s" [selected] [ref=e20]',
    ].join('\n'));
    expect(names.get('e12')).toEqual({ role: 'button', name: 'Save and continue' });
    expect(names.get('f8e383')).toEqual({ role: 'combobox', name: 'Country' });
    expect(names.get('e179')).toEqual({ role: 'button', name: 'Play: the "intro" video' });
    expect(names.get('e1')).toEqual({ role: 'generic', name: '' });
    expect(names.get('e20')).toEqual({ role: 'option', name: 'It\'s' });
    expect(names.size).toBe(5);
  });

  it('knows a reference from visible text', () => {
    expect(REF.test('e5')).toBe(true);
    expect(REF.test('f12e340')).toBe(true);
    expect(REF.test('Email')).toBe(false);
  });
});
