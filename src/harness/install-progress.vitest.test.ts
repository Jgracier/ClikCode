import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFailureTail, startSpinner } from './install-progress.js';
import { waitingSpinnerGlyph } from './protocol/activity-view.js';
import { SPIN_MS } from './protocol/timings.js';

describe('installFailureTail', () => {
  it('keeps the error and drops npm\'s funding and audit noise', () => {
    const log = [
      'npm notice New major version available',
      'npm warn deprecated left-pad@1.0.0: use String.padStart',
      '12 packages are looking for funding',
      'run `npm fund` for details',
      'npm error code E404',
      "npm error 404 Not Found - GET https://registry.npmjs.org/@vendor%2fcli",
    ].join('\n');
    const tail = installFailureTail(log);
    expect(tail).toContain('E404');
    expect(tail).not.toContain('looking for funding');
    expect(tail).not.toContain('deprecated');
  });

  it('is bounded so a failure is not another dump', () => {
    const log = Array.from({ length: 200 }, (_, index) => `npm error line ${index}`).join('\n');
    expect(installFailureTail(log).split('\n')).toHaveLength(12);
  });
});

describe('startSpinner', () => {
  it('prints one plain line and no frames when stdout is not a terminal', () => {
    const written: string[] = [];
    const spinner = startSpinner('Installing X…', (text) => written.push(text), false);
    spinner.stop('Installed X.');
    expect(written).toEqual(['Installing X…\n', 'Installed X.\n']);
  });

  afterEach(() => { vi.useRealTimers(); });

  it('steps as the waiting band\'s spinner does: its glyphs, at SPIN_MS', () => {
    vi.useFakeTimers();
    const written: string[] = [];
    const spinner = startSpinner('Installing X…', (text) => written.push(text), true, false);
    vi.advanceTimersByTime(SPIN_MS - 1);
    expect(written).toHaveLength(1);
    vi.advanceTimersByTime(1);
    spinner.stop();
    expect(written.slice(0, 2).map((text) => text.includes(waitingSpinnerGlyph(written.indexOf(text))))).toEqual([true, true]);
  });

  it('holds still under reduced motion', () => {
    vi.useFakeTimers();
    const written: string[] = [];
    const spinner = startSpinner('Installing X…', (text) => written.push(text), true, true);
    vi.advanceTimersByTime(SPIN_MS * 10);
    spinner.stop();
    expect(written).toHaveLength(2);
  });

  it('clears its line on a terminal so nothing is left behind', () => {
    const written: string[] = [];
    const spinner = startSpinner('Installing X…', (text) => written.push(text), true);
    spinner.stop();
    expect(written[0]).toContain('Installing X…');
    expect(written[written.length - 1]).toBe('\r\u001b[2K');
  });
});
