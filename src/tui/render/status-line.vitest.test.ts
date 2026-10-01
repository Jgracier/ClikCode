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
    expect(statusColour('stalled', 'run')).toBe('red');
  });

  it('writes only the words where there is no colour', () => {
    const painted = paintStatus({ ...base, tone: 'tool', category: 'read', stall: 0, shimmer: true }, new Chalk({ level: 0 }));
    expect(painted).toEqual({ spinner: '⣿', label: 'reading app.ts' });
  });

  it('sweeps a bold highlight on a terminal without truecolor, and never changes the words', () => {
    const chalk = new Chalk({ level: 2 });
    const painted = paintStatus({ ...base, tone: 'tool', category: 'read', stall: 0, shimmer: true }, chalk);
    expect(strip(painted.label)).toBe('reading app.ts');
    expect(painted.label).toContain('\u001b[1m');
    const still = paintStatus({ ...base, tone: 'tool', category: 'read', stall: 0 }, chalk);
    expect(still.label).not.toContain('\u001b[1m');
  });

  it('steps a stall to yellow then red without truecolor', () => {
    const chalk = new Chalk({ level: 1 });
    expect(paintStatus({ ...base, tone: 'thinking', stall: 0.4 }, chalk).spinner).toBe(chalk.yellow('⣿'));
    expect(paintStatus({ ...base, tone: 'stalled', stall: 1 }, chalk).spinner).toBe(chalk.red('⣿'));
    expect(paintStatus({ ...base, tone: 'thinking', stall: 0 }, chalk).spinner).toBe(chalk.cyan('⣿'));
  });

  it('blends toward red, and brightens under the highlight, in truecolor', () => {
    const chalk = new Chalk({ level: 3 });
    expect(paintStatus({ ...base, tone: 'thinking', stall: 0 }, chalk).spinner).toBe(chalk.rgb(80, 200, 220)('⣿'));
    expect(paintStatus({ ...base, tone: 'thinking', stall: 0.5 }, chalk).spinner).toBe(chalk.rgb(158, 143, 153)('⣿'));
    expect(paintStatus({ ...base, tone: 'stalled', stall: 1 }, chalk).spinner).toBe(chalk.rgb(235, 85, 85)('⣿'));
    const shimmering = paintStatus({ ...base, tone: 'thinking', stall: 0, shimmer: true }, chalk);
    expect(strip(shimmering.label)).toBe('reading app.ts');
    const colours = new Set(shimmering.label.match(/38;2;\d+;\d+;\d+/g));
    expect(colours.size).toBeGreaterThan(1);
    // A stall holds the band still: no highlight however it is asked.
    expect(paintStatus({ ...base, tone: 'thinking', stall: 0.2, shimmer: true }, chalk).label).toBe(chalk.rgb(111, 177, 193)('reading app.ts'));
  });
});
