/** Inline-history mode: the conversation is printed once into the terminal's own
 * scrollback and only the composer and status block is redrawn, with relative
 * cursor motion, at the bottom. No alternate screen and no mouse reporting, so
 * a touch scrolls the client's own scrollback.
 *
 * Chosen by the client that wants it: the ClikDeploy phone terminal sets
 * CLIKDEPLOY_CLIENT=mobile in the pty. CLIKCODE_INLINE=1 / 0 forces it on / off. */
export function inlineHistoryMode(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CLIKCODE_INLINE === '1') return true;
  if (env.CLIKCODE_INLINE === '0') return false;
  return env.CLIKDEPLOY_CLIENT === 'mobile';
}

/** Screen and saved lines, then home: replacing the conversation must leave none
 * of the previous one in a scrollback the client keeps. */
export const CLEAR_SCREEN_AND_SCROLLBACK = '\u001b[2J\u001b[3J\u001b[H';

/** Where the last inline frame left the cursor: the rows of the live block it
 * drew and the row within it the cursor is parked on. */
export const inlineBlock = { rows: 0, cursorRow: 0, clearNext: false, last: '' };

/** Cursor-relative erase of the live block, leaving the cursor at column one of
 * its first row. Empty when nothing is drawn. */
export function eraseInlineBlock(): string {
  const out = inlineBlock.rows
    ? `${inlineBlock.cursorRow > 0 ? `\u001b[${inlineBlock.cursorRow}A` : ''}\r\u001b[J`
    : '';
  inlineBlock.rows = 0;
  inlineBlock.cursorRow = 0;
  inlineBlock.last = '';
  return out;
}
