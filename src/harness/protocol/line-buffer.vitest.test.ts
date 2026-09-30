import { describe, expect, it } from 'vitest';
import { LineBuffer } from './json-lines';

describe('lines out of a chunked stream', () => {
  it('splits on \\n and \\r\\n, holding a partial line for the next chunk', () => {
    const lines = new LineBuffer();
    expect(lines.push('one\r\ntw')).toEqual(['one']);
    expect(lines.push('o\nthr')).toEqual(['two']);
    expect(lines.push('ee')).toEqual([]);
    expect(lines.flush()).toBe('three');
    expect(lines.flush()).toBe('');
  });

  it('keeps empty lines, which a caller may skip', () => {
    expect(new LineBuffer().push('a\n\nb\n')).toEqual(['a', '', 'b']);
  });
});
