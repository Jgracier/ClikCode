/** Row budgeting, written as the ways a frame loses a line.
 *
 * This was arithmetic inline in paint(). Getting it wrong does not read as a
 * bug -- it reads as the terminal dropping a row -- which is exactly why it
 * is worth pinning.
 */
import { describe, expect, it } from 'vitest';
import { frameRowBudget } from './frame-budget';

const budget = (over: Partial<Parameters<typeof frameRowBudget>[0]> = {}) =>
  frameRowBudget({ targetHeight: 40, waiting: false, notice: false, requestedPaletteCapacity: 0, ...over });

describe('how many rows each band of a frame gets', () => {
  it('reserves TWO rows for the generating band, never one', () => {
    // Reserving one for a band that draws two pushes the last line of the
    // answer off the screen.
    expect(budget({ waiting: true }).waitingRows).toBe(2);
    expect(budget({ waiting: true }).optionalRows).toBe(40 - 4 - 2);
  });

  it('drops the generating band entirely on a viewport too short to hold it', () => {
    // A software keyboard can do this between two keystrokes.
    expect(budget({ waiting: true, targetHeight: 4 }).waitingRows).toBe(0);
    expect(budget({ waiting: true, targetHeight: 5 }).waitingRows).toBe(2);
  });

  it('never returns a negative budget, however short the viewport', () => {
    for (const targetHeight of [0, 1, 2, 3, 4]) {
      const result = budget({ targetHeight, waiting: true, notice: true, requestedPaletteCapacity: 8 });
      expect(result.optionalRows, `height ${targetHeight}`).toBeGreaterThanOrEqual(0);
      expect(result.paletteRows, `height ${targetHeight}`).toBeGreaterThanOrEqual(0);
    }
  });

  it('gives the notice a row only when one is left to give', () => {
    expect(budget({ notice: true }).noticeRows).toBe(1);
    expect(budget({ notice: true, targetHeight: 4 }).noticeRows).toBe(0);
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
    const withNotice = budget({ notice: true, requestedPaletteCapacity: 40, targetHeight: 10 });
    const without = budget({ notice: false, requestedPaletteCapacity: 40, targetHeight: 10 });
    expect(withNotice.paletteRows).toBe(without.paletteRows - 1);
  });
});
