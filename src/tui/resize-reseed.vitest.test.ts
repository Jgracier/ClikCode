import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stdout } from 'node:process';

const asked = vi.hoisted(() => ({ answer: undefined as number | undefined, count: 0 }));
vi.mock('./input-decoder.js', () => ({ askCursorRow: (done: (row: number | undefined) => void) => { asked.count += 1; done(asked.answer); } }));
const { rewrapIfWidthChanged, anchorBlock } = await import('./prompter/viewport.js');
const { inlineBlock } = await import('./inline.js');

/** What a settled resize owes the transcript: a new width writes the conversation again (its rows are wrapped for a
 * width), a new height writes none of it and only puts the live block back (anchorBlock). */
describe('what a settled resize owes the transcript', () => {
  let requested: number;
  let host: { transcriptColumns: number; emitted: { requestReseed: () => void }; repaint: () => void; closed: boolean; suspended: boolean };
  let repainted: number;
  const size = (columns: number, rows: number): void => {
    Object.defineProperty(stdout, 'columns', { value: columns, configurable: true });
    Object.defineProperty(stdout, 'rows', { value: rows, configurable: true });
  };
  beforeEach(() => {
    requested = 0; repainted = 0; asked.count = 0; asked.answer = undefined;
    host = { transcriptColumns: 69, emitted: { requestReseed: () => { requested += 1; } }, repaint: () => { repainted += 1; }, closed: false, suspended: false };
    size(69, 35);
    Object.assign(inlineBlock, { rows: 6, cursorRow: 3, found: undefined, measuring: false });
  });
  afterEach(() => { vi.unstubAllEnvs(); Object.assign(inlineBlock, { rows: 0, cursorRow: 0, found: undefined, measuring: false }); });

  it('a new height writes no conversation', () => {
    size(69, 67);
    expect(rewrapIfWidthChanged.call(host as never)).toBe(false);
    expect(requested).toBe(0);
  });

  it('a new width writes the conversation again, once', () => {
    size(100, 35);
    expect(rewrapIfWidthChanged.call(host as never)).toBe(true);
    expect(requested).toBe(1);
    expect(rewrapIfWidthChanged.call(host as never)).toBe(false);
    expect(requested).toBe(1);
  });

  it('a new height asks where the cursor is, hands the next frame where the block starts, and holds frames until then', () => {
    asked.answer = 40; // the cursor is on screen row 41; the composer is the block row 3
    anchorBlock.call(host as never);
    expect(asked.count).toBe(1);
    expect(inlineBlock.found).toBe(37);
    expect(inlineBlock.measuring).toBe(false);
    expect(repainted).toBe(1);
  });

  it('a block taller than the screen now is the one height change that writes the conversation again', () => {
    asked.answer = 10; // the cursor is on screen row 11, the composer is the block's row 39: the block starts above the screen
    Object.assign(inlineBlock, { rows: 40, cursorRow: 38 });
    anchorBlock.call(host as never);
    expect(requested).toBe(1);
    expect(inlineBlock.clearNext).toBe(false);
  });

  it('a modal surface is drawn again from its top row: no cursor report is asked for', () => {
    Object.assign(inlineBlock, { page: true });
    anchorBlock.call(host as never);
    expect(asked.count).toBe(0);
    expect(repainted).toBe(1);
    Object.assign(inlineBlock, { page: false });
  });

  it('a terminal that does not answer is left as it is: the frame is drawn like any other', () => {
    anchorBlock.call(host as never);
    expect(inlineBlock.found).toBeUndefined();
    expect(repainted).toBe(1);
  });
});
