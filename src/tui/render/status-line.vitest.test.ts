import { Chalk } from 'chalk';
import { describe, expect, it } from 'vitest';
import { paintStatus, statusColour } from './status-line.js';

const strip = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');
const base = { glyph: '⣿', label: 'reading app.ts', frame: 3, shimmer: false };

describe('the status line', () => {
  it('wears the tone of what the turn is doing', () => {
    expect(statusColour('thinking')).toBe('cyan');
    expect(statusColour('tool', 'edit')).toBe('magenta');
    expect(statusColour('tool')).toBe('cyan');
    expect(statusColour('asking')).toBe('blue');
  });

  it('writes only the words where there is no colour', () => {
    const painted = paintStatus({ ...base, tone: 'tool', category: 'read', shimmer: true }, new Chalk({ level: 0 }));
    expect(painted).toEqual({ spinner: '⣿', label: 'reading app.ts' });
  });

  it('sweeps a bold highlight on a terminal without truecolor, and never changes the words', () => {
    const chalk = new Chalk({ level: 2 });
    const painted = paintStatus({ ...base, tone: 'tool', category: 'read', shimmer: true }, chalk);
    expect(strip(painted.label)).toBe('reading app.ts');
    expect(painted.label).toContain('\u001b[1m');
    const still = paintStatus({ ...base, tone: 'tool', category: 'read' }, chalk);
    expect(still.label).not.toContain('\u001b[1m');
  });

  it('wears its tone, and brightens under the highlight, in truecolor', () => {
    const chalk = new Chalk({ level: 3 });
    expect(paintStatus({ ...base, tone: 'thinking' }, chalk).spinner).toBe(chalk.rgb(80, 200, 220)('⣿'));
    const shimmering = paintStatus({ ...base, tone: 'thinking', shimmer: true }, chalk);
    expect(strip(shimmering.label)).toBe('reading app.ts');
    const colours = new Set(shimmering.label.match(/38;2;\d+;\d+;\d+/g));
    expect(colours.size).toBeGreaterThan(1);
  });

  it('turns only the spinner yellow when the turn has stalled', () => {
    const chalk = new Chalk({ level: 3 });
    const stalled = paintStatus({ ...base, tone: 'thinking', stalled: true }, chalk);
    expect(stalled.spinner).toBe(chalk.rgb(230, 190, 90)('⣿'));
    expect(stalled.label).toBe(paintStatus({ ...base, tone: 'thinking' }, chalk).label);
    expect(paintStatus({ ...base, tone: 'thinking', stalled: true }, new Chalk({ level: 1 })).spinner).toBe(new Chalk({ level: 1 }).yellow('⣿'));
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
