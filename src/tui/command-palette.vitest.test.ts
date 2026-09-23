import { describe, expect, it } from 'vitest';
import { commandPaletteMatches, composerRightArrowValue, pickerConfirmsSelection, pickerDeletesSelection, completedCommandLine } from './command-palette';

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

/** `/model op` lists models instead of a hint and a second picker. */
describe('completing a command\'s argument from its real values', () => {
  const models = [{ value: 'opus', detail: 'Opus 5.5' }, { value: 'sonnet', detail: 'Sonnet 5' }, { value: 'haiku', detail: 'Haiku 4.5' }, { value: 'opusplan' }];
  const commands = [
    { label: '/model', value: '/model', argHint: '[name]', argValues: () => models },
    { label: '/rename', value: '/rename', argHint: '[name]' },
  ];

  it('lists the values that match what has been typed, best first', () => {
    const rows = commandPaletteMatches('/model op', commands);
    expect(rows.map((row) => row.label)).toEqual(['opus', 'opusplan']);
    expect(rows[0]).toMatchObject({ value: '/model opus', detail: 'Opus 5.5', completes: true });
  });

  it('lists every value before anything is typed', () => {
    expect(commandPaletteMatches('/model ', commands).map((row) => row.label)).toEqual(['opus', 'sonnet', 'haiku', 'opusplan']);
  });

  it('matches on the description too, so a version finds its alias', () => {
    expect(commandPaletteMatches('/model 5.5', commands).map((row) => row.label)).toEqual(['opus']);
  });

  it('keeps the hint for a command whose argument is free text', () => {
    expect(commandPaletteMatches('/rename my', commands)).toEqual([commands[1]]);
  });

  it('keeps the hint while nothing matches, rather than an empty palette', () => {
    expect(commandPaletteMatches('/model zzz', commands)).toEqual([commands[0]]);
  });

  it('runs what was typed when it is exactly a value, and the chosen one when it is not', () => {
    expect(completedCommandLine('/model opus', commands)).toBe('/model opus');
    expect(completedCommandLine('/model op', commands)).toBe('/model opus');
    expect(completedCommandLine('/model op', commands, 1)).toBe('/model opusplan');
    expect(completedCommandLine('/rename my chat', commands)).toBe('/rename my chat');
  });
});
