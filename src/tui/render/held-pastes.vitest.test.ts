import { describe, expect, it } from 'vitest';
import { expandPastes, insertPaste, keptPastes, removePlaceholderAt } from './held-pastes.js';

const log = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n');

describe('long pastes held as a placeholder', () => {
  it('holds a long paste and inserts a short one as it is', () => {
    const short = insertPaste({ value: 'see ', cursor: 4, held: [] }, 'a b', 1);
    expect(short).toEqual({ value: 'see a b', cursor: 7, held: [] });
    const long = insertPaste({ value: 'see  please', cursor: 4, held: [] }, log, 1);
    expect(long.value).toBe('see [Pasted text #1 +40 lines] please');
    expect(long.cursor).toBe('see [Pasted text #1 +40 lines]'.length);
    expect(expandPastes(long.value, long.held)).toBe(`see ${log} please`);
  });

  it('deletes a placeholder whole, and its paste with it', () => {
    const draft = insertPaste({ value: 'x', cursor: 1, held: [] }, log, 2);
    const back = removePlaceholderAt(draft, 'back')!;
    expect(back).toEqual({ value: 'x', cursor: 1, held: [] });
    expect(removePlaceholderAt({ ...draft, cursor: 1 }, 'forward')).toEqual({ value: 'x', cursor: 1, held: [] });
    // Not at one: the key is an ordinary edit.
    expect(removePlaceholderAt({ ...draft, cursor: 0 }, 'back')).toBeUndefined();
  });

  it('drops a paste whose placeholder an edit broke', () => {
    const draft = insertPaste({ value: '', cursor: 0, held: [] }, log, 3);
    expect(keptPastes(draft.value, draft.held)).toHaveLength(1);
    expect(keptPastes(draft.value.slice(0, -2), draft.held)).toEqual([]);
    expect(expandPastes(draft.value.slice(0, -2), [])).toBe('[Pasted text #3 +40 line');
  });

  it('keeps two pastes apart', () => {
    let draft = insertPaste({ value: '', cursor: 0, held: [] }, log, 1);
    draft = insertPaste({ ...draft, value: `${draft.value} and `, cursor: draft.value.length + 5 }, 'x'.repeat(900), 2);
    expect(draft.value).toBe('[Pasted text #1 +40 lines] and [Pasted text #2]');
    expect(expandPastes(draft.value, draft.held)).toBe(`${log} and ${'x'.repeat(900)}`);
  });
});
