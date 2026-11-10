/** Which screen model runs.
 *
 * The default is FULL-SCREEN everywhere (local, ssh, ClikDeploy's phone page, tmux, screen, plain terminals): the alternate screen,
 * every row drawn at an absolute address on every frame and every resize, the composer and status on the last row, the
 * conversation kept here and scrolled by key (PageUp, PageDown, arrows, Home, End) or by whatever the client turns a wheel or
 * a swipe into (arrows, in the alternate screen). No mouse reporting, so the client's own selection and copy work. When the
 * program ends, or is suspended, the conversation is written into the normal screen (restore.ts, historyDump) so it is in the
 * client's scrollback and selectable.
 *
 * Inline-history mode is the opt-in, CLIKCODE_INLINE=1: the conversation is printed once into the terminal's own scrollback and only
 * the composer and status block is redrawn, with relative cursor motion. It depends on the client keeping its rows steady when
 * the window changes size, which no remote client promises, so nothing chooses it for you. */
export function inlineHistoryMode(env: NodeJS.ProcessEnv = process.env): boolean {
  // ClikDeploy's phone shells were all opened with CLIKCODE_INLINE=1 next to CLIKDEPLOY_CLIENT=mobile (a held shell keeps its
  // environment for good), which chose inline for every phone session. Nobody who opts in by hand sets the client marker, so
  // the pair is the platform's and is not a choice.
  if (env.CLIKDEPLOY_CLIENT === 'mobile') return false;
  return env.CLIKCODE_INLINE === '1';
}

/** A client that ignores the alternate screen: GNU screen ships with `altscreen off`, so `?1049h` and `?1049l` are swallowed. The program
 * then draws on the one screen there is, and on the way out must erase what it drew before the conversation is written under the
 * shell. STY is screen's own variable (TERM says nothing: tmux sets screen* too); tmux keeps the alternate screen, and a pane
 * inside screen has both, so TMUX wins. */
export function swallowsAlternateScreen(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.STY) && !env.TMUX;
}

/** Screen and saved lines, then home: replacing the conversation must leave none
 * of the previous one in a scrollback the client keeps. */
export const CLEAR_SCREEN_AND_SCROLLBACK = '\u001b[2J\u001b[3J\u001b[H';

/** The visible screen only, then home: the saved lines are the conversation and stay. Not `ESC[2J`: tmux (scroll-on-clear)
 * copies a screen that is cleared whole, from its first row, into its history. Row one is erased by itself and the rest from
 * row two on, which no terminal keeps. */
export const CLEAR_SCREEN = '\u001b[H\u001b[K\u001b[2;1H\u001b[J\u001b[H';

/** Where the last inline frame left the cursor: the rows of the live block it
 * drew and the row within it the cursor is parked on. */
export const inlineBlock = {
  rows: 0, cursorRow: 0, clearNext: false, last: '', liveRows: [] as string[], columns: 0,
  /** The blank rows above the conversation (a conversation shorter than the screen, drawn on the last rows at the start) that
   * retired rows have not yet used. Only true while the block ends on the last row: a resize or a shrinking block zeroes it. */
  pad: 0,
  /** The screen row the block's first row is on: measured after a change of height, otherwise followed from where it was drawn. */
  top: 0,
  /** The screen height the block was last drawn for. */
  height: 0,
  /** After a settled change of height, the screen row the block's first row is on, from the terminal's cursor report
   * (negative: its top rows went into the saved lines); undefined when nothing was asked. The next frame consumes it.
   * `measuring` holds frames back while the question is out. */
  found: undefined as number | undefined, measuring: false,
  /** The cursor report never came back after a change of height: the block is erased and drawn again relative to where
   * it was last left (see anchorBlock). */
  lost: false,
  /** A modal surface (the board, the palette, a picker) is on screen: it is drawn on the ALTERNATE screen (`?1049h`), from its
   * top row, so no saved lines exist behind it in any client and the main screen (the conversation and its live block) is not
   * touched; closing it (`?1049l`) shows that screen again as it was. `main` is the block's state on the main screen, kept while
   * the page is up and put back when it closes. `tail` is every row the conversation retired meanwhile: written above the block
   * once the page is gone. `resized`: the size changed while it was up, so the main screen is measured again on close.
   * `wipe`: the conversation was rewritten (a new width) while it was up, so the main screen is cleared and it is written whole. */
  page: false, tail: [] as string[], resized: false, wipe: false,
  main: undefined as undefined | { rows: number; cursorRow: number; last: string; liveRows: string[]; pad: number; top: number; height: number; columns: number },
};

/** The alternate screen a page is drawn on, and its way back. */
export const ENTER_PAGE_SCREEN = `\u001b[?1049h${CLEAR_SCREEN}`;
export const LEAVE_PAGE_SCREEN = '\u001b[?1049l';

/** The main screen's block state, put back as the page closes. */
export function restoreMainBlock(): void {
  const main = inlineBlock.main;
  inlineBlock.main = undefined;
  inlineBlock.page = false;
  if (main) Object.assign(inlineBlock, main, { found: undefined, lost: false });
}

/** Cursor-relative erase of the live block, leaving the cursor at column one of
 * its first row. Empty when nothing is drawn. */
export function eraseInlineBlock(): string {
  const out = inlineBlock.rows
    ? `${inlineBlock.cursorRow > 0 ? `\u001b[${inlineBlock.cursorRow}A` : ''}\r\u001b[J`
    : '';
  inlineBlock.rows = 0;
  inlineBlock.cursorRow = 0;
  inlineBlock.last = '';
  inlineBlock.liveRows = [];
  inlineBlock.pad = 0;
  return out;
}
