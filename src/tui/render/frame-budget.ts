/** How many rows each band of one frame may have.
 *
 * Pulled out of paint() because it is arithmetic with invariants, and getting
 * it wrong does not look like a bug -- it looks like the terminal losing a
 * line. Every rule below is one that has already cost something.
 */

export type FrameBudget = {
  /** The generating band: a spinner and an elapsed clock, directly above the
   *  composer. */
  waitingRows: number;
  noticeRows: number;
  /** 0 when the palette cannot be given enough rows to be usable. */
  paletteRows: number;
  /** What is left for the optional bands -- approval, thought, plan, panel --
   *  after the fixed footer, the waiting band and the notice. */
  optionalRows: number;
};

/** Below this the frame has no room for a two-row status band at all. */
const WAITING_BAND_MIN_HEIGHT = 5;
/** A palette shorter than this shows no options, only its own chrome. */
const PALETTE_MIN_ROWS = 3;
/** One composer row plus three fixed footer rows. */
const FIXED_FOOTER_ROWS = 4;

export function frameRowBudget(input: {
  targetHeight: number;
  /** Whether a turn is in flight, i.e. the generating band is drawn. */
  waiting: boolean;
  notice: boolean;
  requestedPaletteCapacity: number;
}): FrameBudget {
  // TWO rows, not one: the generating line, and a blank above it so the text
  // still being written is not flush against the spinner. Counted here
  // because this number IS the height budget -- reserve one row for a band
  // that draws two and the last line of the answer is pushed off the screen.
  const waitingRows = input.waiting && input.targetHeight >= WAITING_BAND_MIN_HEIGHT ? 2 : 0;
  let optionalRows = Math.max(0, input.targetHeight - FIXED_FOOTER_ROWS - waitingRows);
  const noticeRows = input.notice && optionalRows > 0 ? 1 : 0;
  optionalRows -= noticeRows;
  const available = Math.min(input.requestedPaletteCapacity, optionalRows);
  // All or nothing: a palette with one or two rows is its own border and no
  // options, which reads as a broken frame rather than a short list.
  const paletteRows = available >= PALETTE_MIN_ROWS ? available : 0;
  return { waitingRows, noticeRows, paletteRows, optionalRows };
}
