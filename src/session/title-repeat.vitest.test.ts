import { describe, expect, it } from 'vitest';
import { stripRepeatedTitles } from './title';

describe('a title repeated by a later step', () => {
  it('is removed wherever a step began with it, and nothing else is', () => {
    expect(stripRepeatedTitles('\n\n<clikcode-title>Fix</clikcode-title>\nFixed it.')).toBe('Fixed it.');
    expect(stripRepeatedTitles('Reading.\n\n<clikcode-title>Fix</clikcode-title>\nFixed it.')).toBe('Reading.\n\nFixed it.');
    expect(stripRepeatedTitles('    indented code stays')).toBe('    indented code stays');
    expect(stripRepeatedTitles('We discussed <clikcode-title>x</clikcode-title> inline.')).toBe('We discussed <clikcode-title>x</clikcode-title> inline.');
  });
});
