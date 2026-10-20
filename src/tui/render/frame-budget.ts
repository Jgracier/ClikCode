/** How many rows each band of one frame may have.
 *
 * Pulled out of paint() because it is arithmetic with invariants, and getting
 * it wrong does not look like a bug -- it looks like the terminal losing a
 * line. Every rule below is one that has already cost something.
 */

type FrameBudget = {
  /** The generating band: a spinner and an elapsed clock, directly above the
   *  composer. */
  waitingRows: number;
  /** 0 when the palette cannot be given enough rows to be usable. */
  paletteRows: number;
  /** What is left for the optional bands -- approval, thought, plan, panel --
   *  after the fixed footer and the waiting band. A notice and the
   *  background-terminals indicator take none: they are drawn inside rows
   *  that exist already (paint/footer.ts), so the footer keeps its height. */
  optionalRows: number;
};

/** Below this the frame has no room for a two-row status band at all. */
const WAITING_BAND_MIN_HEIGHT = 5;
/** A palette shorter than this shows no options, only its own chrome. */
const PALETTE_MIN_ROWS = 3;
/** The usage rule, the title rule and the provider/model line under the composer. */
export const FOOTER_CHROME_ROWS = 3;
/** The composer always has a row. */
export const MIN_COMPOSER_ROWS = 1;
/** One composer row plus three fixed footer rows. */
export const FIXED_FOOTER_ROWS = MIN_COMPOSER_ROWS + FOOTER_CHROME_ROWS;

/** Whether the status band has the room for its blank row. The band is two
 * rows while a turn runs (a blank above the status) and two blank rows at
 * rest, so the footer is the same height on both sides of a turn; below this
 * height only the status (or one blank) stays. One rule, used by the budget
 * and by the footer. */
export const hasBandBlank = (targetHeight: number): boolean => targetHeight >= WAITING_BAND_MIN_HEIGHT;

export function frameRowBudget(input: {
  targetHeight: number;
  /** Whether a turn is in flight, i.e. the generating band is drawn. */
  waiting: boolean;
  requestedPaletteCapacity: number;
}): FrameBudget {
  // TWO rows, not one: the generating line, and a blank above it so the text
  // still being written is not flush against the spinner. Counted here
  // because this number IS the height budget -- reserve one row for a band
  // that draws two and the last line of the answer is pushed off the screen.
  // Too short for the blank, the status itself stays: one row. A status that
  // vanishes with the room is a turn that looks stopped (or, with an approval
  // up, blocked with no word on why).
  const waitingRows = !input.waiting ? 0 : hasBandBlank(input.targetHeight) ? 2 : 1;
  const optionalRows = Math.max(0, input.targetHeight - FIXED_FOOTER_ROWS - waitingRows);
  const available = Math.min(input.requestedPaletteCapacity, optionalRows);
  // All or nothing: a palette with one or two rows is its own border and no
  // options, which reads as a broken frame rather than a short list.
  const paletteRows = available >= PALETTE_MIN_ROWS ? available : 0;
  // The list covers chat above the footer (paint/frame.ts) and takes no row.
  return { waitingRows, paletteRows, optionalRows };
}

/** The least an approval or a question may be given: its question and its
 * keys. The block degrades to this, never to nothing (standard section 8). */
export const APPROVAL_MIN_ROWS = 2;

/** The footer when an approval or question is up and the terminal is short:
 * the rows that are not the prompt go first, so the turn is never blocked
 * invisibly. In order, what is given up: everything above the prompt
 * (notice, palette, panel, plan), the thought and sign-in rows, the blank
 * over the status, the provider/model line, the composer's lower rule, and
 * then the prompt's own leading rows -- never its last (the keys), the
 * status, the composer's row or its upper rule while anything else is left.
 * Returns the rows and where the composer's first row sits in them. */
export function fitFooterForApproval(parts: {
  above: readonly string[]; approval: readonly string[]; mid: readonly string[];
  blank: string | undefined; status: string | undefined;
  usageRule: string; composer: readonly string[]; titleRule: string; meta: string;
  height: number;
}): { rows: string[]; composerStart: number } {
  let above = [...parts.above];
  let approval = [...parts.approval];
  let mid = [...parts.mid];
  let blank = parts.blank;
  let meta: string | undefined = parts.meta;
  let titleRule: string | undefined = parts.titleRule;
  const status = parts.status;
  const total = (): number => above.length + approval.length + mid.length + (blank === undefined ? 0 : 1)
    + (status === undefined ? 0 : 1) + 1 + parts.composer.length + (titleRule === undefined ? 0 : 1) + (meta === undefined ? 0 : 1);
  const over = (): number => total() - parts.height;
  if (over() > 0) above = [];
  if (over() > 0) mid = [];
  if (over() > 0) blank = undefined;
  if (over() > 0) meta = undefined;
  if (over() > 0) titleRule = undefined;
  if (over() > 0) approval = approval.slice(Math.min(over(), Math.max(0, approval.length - 1)));
  const head = [...above, ...approval, ...mid, ...(blank === undefined ? [] : [blank]), ...(status === undefined ? [] : [status])];
  return {
    rows: [...head, parts.usageRule, ...parts.composer, ...(titleRule === undefined ? [] : [titleRule]), ...(meta === undefined ? [] : [meta])],
    composerStart: head.length + 1,
  };
}
