import { describe, expect, it } from 'vitest';
import { commandPaletteMatches, composerRightArrowValue, pickerConfirmsSelection, pickerDeletesSelection } from './command-palette';

describe('command palette layout', () => {
  it('opens the main slash choices from Right Arrow only when the composer is empty', () => {
    expect(composerRightArrowValue('', false, true)).toBe('/');
    expect(composerRightArrowValue('draft', false, true)).toBeUndefined();
    expect(composerRightArrowValue('', true, true)).toBeUndefined();
  });

  it('uses Right Arrow or Enter to choose and Delete only for destructive row actions', () => {
    expect(['\r', '\n', '\u001b[C'].every(pickerConfirmsSelection)).toBe(true);
    expect(pickerConfirmsSelection('\u001b[3~')).toBe(false);
    expect(pickerDeletesSelection('\u001b[3~')).toBe(true);
  });

  it('reserves confirmation for Enter so Left Arrow can consistently navigate back', () => {
    expect(pickerConfirmsSelection('\r')).toBe(true);
    expect(pickerConfirmsSelection('\u001b[D')).toBe(false);
  });

  it('fully reclaims the palette rows as soon as the slash is deleted', () => {
    const commands = [{ label: '/help', value: '/help' }, { label: '/model', value: '/model' }];
    expect(commandPaletteMatches('/', commands)).toHaveLength(2);
    expect(commandPaletteMatches('', commands)).toEqual([]);
  });
});
