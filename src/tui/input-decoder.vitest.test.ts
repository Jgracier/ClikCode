import { describe, expect, it } from 'vitest';
import { TerminalInputDecoder } from './input-decoder';
import { editWaitingComposer } from './composer-edit';

describe('terminal input decoding', () => {
  it('buffers fragmented Termius escape sequences and UTF-8 characters', () => {
    const decoder = new TerminalInputDecoder();
    expect(decoder.push(Buffer.from('\u001b'))).toEqual([]);
    expect(decoder.push(Buffer.from('[D'))).toEqual(['\u001b[D']);
    expect(decoder.push(Buffer.from('\u001bOD\u001b[1;5C'))).toEqual(['\u001b[D', '\u001b[C']);
    const wide = Buffer.from('界');
    expect(decoder.push(wide.subarray(0, 1))).toEqual([]);
    expect(decoder.push(wide.subarray(1))).toEqual(['界']);
    expect(decoder.push(Buffer.from('\u001b'))).toEqual([]);
    expect(decoder.flush()).toEqual(['\u001b']);
    expect(decoder.push(Buffer.from('x'))).toEqual(['x']);
    expect(decoder.push(Buffer.from('\u001by'))).toEqual(['\u001by']);
  });

  it('edits a real composer during generation instead of discarding typed keys', () => {
    let draft = { value: '', cursor: 0, changed: false };
    for (const key of ['n', 'e', 'x', 't']) draft = editWaitingComposer(draft.value, draft.cursor, key);
    draft = editWaitingComposer(draft.value, draft.cursor, '\u001b[D');
    draft = editWaitingComposer(draft.value, draft.cursor, '!');
    expect(draft).toEqual({ value: 'nex!t', cursor: 4, changed: true });
    expect(editWaitingComposer(draft.value, draft.cursor, '\u007f')).toEqual({ value: 'next', cursor: 3, changed: true });
  });
});
