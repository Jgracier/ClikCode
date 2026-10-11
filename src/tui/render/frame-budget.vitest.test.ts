/** Row budgeting, written as the ways a frame loses a line.
 *
 * This was arithmetic inline in paint(). Getting it wrong does not read as a
 * bug -- it reads as the terminal dropping a row -- which is exactly why it
 * is worth pinning.
 */
import { describe, expect, it } from 'vitest';
import { APPROVAL_MIN_ROWS, fitFooterForApproval, frameRowBudget } from './frame-budget';

const budget = (over: Partial<Parameters<typeof frameRowBudget>[0]> = {}) =>
  frameRowBudget({ targetHeight: 40, waiting: false, notice: 0, requestedPaletteCapacity: 0, ...over });

describe('how many rows each band of a frame gets', () => {
  it('reserves TWO rows for the generating band, never one', () => {
    // Reserving one for a band that draws two pushes the last line of the
    // answer off the screen.
    expect(budget({ waiting: true }).waitingRows).toBe(2);
    expect(budget({ waiting: true }).optionalRows).toBe(40 - 4 - 2);
  });

  it('keeps a one-row status on a viewport too short for the whole band', () => {
    // A software keyboard can do this between two keystrokes. The blank row
    // goes; the status does not (it was dropped entirely before, which left
    // an approval blocking the turn with no word on why).
    expect(budget({ waiting: true, targetHeight: 4 }).waitingRows).toBe(1);
    expect(budget({ waiting: true, targetHeight: 5 }).waitingRows).toBe(2);
    expect(budget({ waiting: false, targetHeight: 4 }).waitingRows).toBe(0);
  });

  it('never returns a negative budget, however short the viewport', () => {
    for (const targetHeight of [0, 1, 2, 3, 4]) {
      const result = budget({ targetHeight, waiting: true, notice: 1, requestedPaletteCapacity: 8 });
      expect(result.optionalRows, `height ${targetHeight}`).toBeGreaterThanOrEqual(0);
      expect(result.paletteRows, `height ${targetHeight}`).toBeGreaterThanOrEqual(0);
    }
  });

  it('gives a wrapped notice its rows, as many as are left', () => {
    expect(budget({ notice: 3 }).noticeRows).toBe(3);
    expect(budget({ notice: 3, targetHeight: 6 }).noticeRows).toBe(2);
  });

  it('gives the notice a row only when one is left to give', () => {
    expect(budget({ notice: 1 }).noticeRows).toBe(1);
    expect(budget({ notice: 1, targetHeight: 4 }).noticeRows).toBe(0);
  });

  it('gives the palette nothing rather than a border with no options in it', () => {
    // All or nothing: one or two rows is its own chrome and no list, which
    // reads as a broken frame rather than a short one.
    expect(budget({ requestedPaletteCapacity: 8, targetHeight: 6 }).paletteRows).toBe(2 < 3 ? 0 : 2);
    expect(budget({ requestedPaletteCapacity: 8, targetHeight: 7 }).paletteRows).toBe(3);
    expect(budget({ requestedPaletteCapacity: 8, targetHeight: 40 }).paletteRows).toBe(8);
  });

  it('never gives the palette more than it asked for', () => {
    expect(budget({ requestedPaletteCapacity: 5, targetHeight: 80 }).paletteRows).toBe(5);
  });

  it('takes the bands in order, so the palette sees what the notice left', () => {
    const withNotice = budget({ notice: 1, requestedPaletteCapacity: 40, targetHeight: 10 });
    const without = budget({ notice: false, requestedPaletteCapacity: 40, targetHeight: 10 });
    expect(withNotice.paletteRows).toBe(without.paletteRows - 1);
  });
});

describe('a footer that must hold an approval', () => {
  const parts = {
    above: ['notice', 'palette-1', 'palette-2'], approval: ['? Run make?', '    $ make', '  [y] [n]'], mid: ['thought'],
    blank: '', status: 'status', usageRule: 'usage', composer: ['> '], titleRule: 'title', meta: 'meta', height: 40,
  };

  it('is everything, in order, when there is room', () => {
    const { rows, composerStart } = fitFooterForApproval(parts);
    expect(rows).toEqual(['notice', 'palette-1', 'palette-2', '? Run make?', '    $ make', '  [y] [n]', 'thought', '', 'status', 'usage', '> ', 'title', 'meta']);
    expect(rows[composerStart]).toBe('> ');
  });

  it('gives up everything but the prompt, the status and the composer before the prompt itself', () => {
    for (const height of [5, 6, 7, 8, 9, 10]) {
      const { rows, composerStart } = fitFooterForApproval({ ...parts, height });
      expect(rows.length, `height ${height}`).toBeLessThanOrEqual(height);
      expect(rows, `height ${height}`).toContain('  [y] [n]');
      expect(rows, `height ${height}`).toContain('status');
      expect(rows[composerStart], `height ${height}`).toBe('> ');
    }
    // Five rows: what is being approved and its keys, the status, the rule
    // over the composer, the composer.
    expect(fitFooterForApproval({ ...parts, height: 5 }).rows).toEqual(['    $ make', '  [y] [n]', 'status', 'usage', '> ']);
    expect(fitFooterForApproval({ ...parts, height: 6 }).rows).toEqual(['? Run make?', '    $ make', '  [y] [n]', 'status', 'usage', '> ']);
  });

  it('never asks for less than the question and its keys', () => {
    expect(APPROVAL_MIN_ROWS).toBe(2);
    expect(fitFooterForApproval({ ...parts, approval: ['? Run make?', '  [y] [n]'], height: 4 }).rows.slice(0, 2)).toEqual(['  [y] [n]', 'status']);
    expect(fitFooterForApproval({ ...parts, approval: ['? Run make?', '  [y] [n]'], height: 5 }).rows.slice(0, 2)).toEqual(['? Run make?', '  [y] [n]']);
  });
});
