import { describe, expect, it } from 'vitest';
import { withoutRecapLine } from './recap-line.js';

describe('withoutRecapLine', () => {
  it('leaves text with no recap line alone', () => {
    expect(withoutRecapLine('Done.\n\nAll green.')).toBe('Done.\n\nAll green.');
    expect(withoutRecapLine('Use [Did: x] mid-line and go on')).toBe('Use [Did: x] mid-line and go on');
  });

  it('drops a closing line of its own', () => {
    expect(withoutRecapLine('Fixed it.\n\n[Did: $ cd /tmp && clikdeploy ... · and 5 more]\n')).toBe('Fixed it.');
  });

  it('drops several closing recap lines, keeping the words above', () => {
    expect(withoutRecapLine('One.\n[Did: a]\n\n[Did: b · and 2 more]  \n\n')).toBe('One.');
  });

  it('drops a recap that ends a line of words', () => {
    expect(withoutRecapLine('All done. [Did: Edit src/a.ts · and 3 more]')).toBe('All done.');
  });

  it('keeps a labelled line that is not last', () => {
    expect(withoutRecapLine('[Did: a]\nthen more words')).toBe('[Did: a]\nthen more words');
  });

  it('is empty when the reply was only a recap', () => {
    expect(withoutRecapLine('[Did: a · b]')).toBe('');
  });
});
