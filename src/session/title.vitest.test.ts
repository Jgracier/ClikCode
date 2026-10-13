import { describe, expect, it } from 'vitest';
import { SESSION_TITLE_MAX, carriesTitleRequest, normalizeSessionTitle, titleFromFirstMessage } from './title.js';

describe('naming a conversation', () => {
  it('cuts an over-long name on a word boundary', () => {
    expect(normalizeSessionTitle('"  Scrolling   and cursor placement on phones. "')).toBe('Scrolling and');
    expect(normalizeSessionTitle('supercalifragilisticexpialidocious')).toHaveLength(SESSION_TITLE_MAX);
    expect(normalizeSessionTitle('   ')).toBeUndefined();
  });

  it('names a chat from the first message and never edits it', () => {
    expect(titleFromFirstMessage('fix the parser')).toBe('fix the parser');
    expect(titleFromFirstMessage('fix the parser crash on empty input please')).toBe('fix the parser');
    expect(titleFromFirstMessage('')).toBeUndefined();
  });

  it('still recognises the title request an older ClikCode appended', () => {
    expect(carriesTitleRequest('test\n\n<clikcode-title>Start with a title</clikcode-title>')).toBe(true);
    expect(carriesTitleRequest('test')).toBe(false);
  });
});
