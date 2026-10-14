import { Chalk } from 'chalk';
import { describe, expect, it } from 'vitest';
import { LOOK, xtermRgb } from '../../harness/protocol/look.js';
import { paintStatus } from './status-line.js';

const strip = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');
const base = { glyph: '⣿', label: 'reading app.ts', frame: 3, shimmer: false };

describe('the status line', () => {
  it('wears one colour for every tone and every tool: the look accent', () => {
    const chalk = new Chalk({ level: 3 });
    const accent = chalk.rgb(...xtermRgb(LOOK.roles.accent.ansi))('⣿');
    for (const tone of ['thinking', 'tool', 'asking'] as const) expect(paintStatus({ ...base, tone }, chalk).spinner).toBe(accent);
  });

  it('writes only the words where there is no colour', () => {
    const painted = paintStatus({ ...base, tone: 'tool', shimmer: true }, new Chalk({ level: 0 }));
    expect(painted).toEqual({ spinner: '⣿', label: 'reading app.ts' });
  });

  it('sweeps a bold highlight on a terminal without truecolor, and never changes the words', () => {
    const chalk = new Chalk({ level: 2 });
    const painted = paintStatus({ ...base, tone: 'tool', shimmer: true }, chalk);
    expect(strip(painted.label)).toBe('reading app.ts');
    expect(painted.label).toContain('\u001b[1m');
    const still = paintStatus({ ...base, tone: 'tool' }, chalk);
    expect(still.label).not.toContain('\u001b[1m');
  });

  it('wears its tone, and brightens under the highlight, in truecolor', () => {
    const chalk = new Chalk({ level: 3 });
    expect(paintStatus({ ...base, tone: 'thinking' }, chalk).spinner).toBe(chalk.rgb(...xtermRgb(LOOK.roles.accent.ansi))('⣿'));
    const shimmering = paintStatus({ ...base, tone: 'thinking', shimmer: true }, chalk);
    expect(strip(shimmering.label)).toBe('reading app.ts');
    const colours = new Set(shimmering.label.match(/38;2;\d+;\d+;\d+/g));
    expect(colours.size).toBeGreaterThan(1);
  });

  it('turns only the spinner to the stopped colour when the turn has stalled', () => {
    const chalk = new Chalk({ level: 3 });
    const stalled = paintStatus({ ...base, tone: 'thinking', stalled: true }, chalk);
    expect(stalled.spinner).toBe(chalk.rgb(...xtermRgb(LOOK.roles.stopped.ansi))('⣿'));
    expect(stalled.label).toBe(paintStatus({ ...base, tone: 'thinking' }, chalk).label);
    expect(paintStatus({ ...base, tone: 'thinking', stalled: true }, new Chalk({ level: 1 })).spinner).toBe(new Chalk({ level: 1 }).ansi256(LOOK.roles.stopped.ansi)('⣿'));
  });

  it('writes a colour where it changes, not around every character', () => {
    const label = 'thinking about the repository layout now';
    for (const level of [1, 3] as const) {
      const shimmering = paintStatus({ ...base, label, tone: 'thinking', frame: 2, shimmer: true }, new Chalk({ level }));
      expect(strip(shimmering.label)).toBe(label);
      const opens = shimmering.label.match(/\u001b\[(?:1|3\d|38;2;\d+;\d+;\d+)m/g) ?? [];
      // One run before the highlight, its few blended steps, one after.
      expect(opens.length).toBeLessThan(label.length / 2);
    }
  });
});
