import { spawnSync } from 'node:child_process';

/** Inline-history mode: the conversation is printed once into the terminal's own
 * scrollback and only the composer and status block is redrawn, with relative
 * cursor motion, at the bottom. No alternate screen and no mouse reporting, so
 * a touch scrolls the client's own scrollback.
 *
 * Which mode runs, first match wins:
 *   1. CLIKCODE_INLINE=1 / 0 forces inline / full-screen.
 *   2. GNU screen (STY set, or TERM screen* outside tmux) is inline: screen ships with `altscreen off`, so it
 *      swallows the alternate screen. tmux does not: it keeps the alternate screen, and what it does not do is pass
 *      the mouse to the program unless its `mouse` option is on, and full-screen scrolls by wheel. So inside tmux
 *      the mode follows that option (asked once, `tmux show-options -gv mouse`): mouse on, the rules below; off, inline.
 *   3. TERM=dumb or linux (the console has no reliable alternate screen or mouse) is inline.
 *   4. A known good local terminal (TERM_PROGRAM iTerm.app, Apple_Terminal, WezTerm, ghostty,
 *      kitty, vscode, Alacritty; or the matching TERM) is full-screen, even over ssh.
 *   5. Over ssh (SSH_CONNECTION or SSH_TTY) from a terminal not known to be a good one: inline. ssh does not carry
 *      TERM_PROGRAM, so this is every ssh session whose TERM does not name a good terminal. The width of the window says
 *      nothing about it (a wide window over ssh scrolls as badly as a narrow one), so it is not read.
 *   6. Otherwise full-screen. */
const GOOD_TERMINAL_PROGRAMS = new Set(['iterm.app', 'apple_terminal', 'wezterm', 'ghostty', 'kitty', 'vscode', 'alacritty']);
const GOOD_TERMS = new Set(['xterm-kitty', 'alacritty', 'xterm-ghostty', 'wezterm']);

/** Whether the tmux this runs in forwards the mouse to programs (its `mouse` option), asked once per process. */
let tmuxMouse: boolean | undefined;
export function tmuxForwardsMouse(): boolean {
  if (tmuxMouse === undefined) {
    try {
      tmuxMouse = spawnSync('tmux', ['show-options', '-gv', 'mouse'], { encoding: 'utf8', timeout: 500 }).stdout.trim() === 'on';
    } catch { tmuxMouse = false; }
  }
  return tmuxMouse;
}

export function inlineHistoryMode(env: NodeJS.ProcessEnv = process.env, tmuxMouseOn: () => boolean = tmuxForwardsMouse): boolean {
  if (env.CLIKCODE_INLINE === '1') return true;
  if (env.CLIKCODE_INLINE === '0') return false;
  const term = (env.TERM ?? '').toLowerCase();
  if (env.TMUX) { if (!tmuxMouseOn()) return true; }
  else if (env.STY || term.startsWith('screen') || term.startsWith('tmux')) return true;
  if (term === 'dumb' || term === 'linux') return true;
  const program = (env.TERM_PROGRAM ?? '').toLowerCase();
  const good = GOOD_TERMINAL_PROGRAMS.has(program) || GOOD_TERMS.has(term);
  if (good) return false;
  return Boolean(env.SSH_CONNECTION || env.SSH_TTY);
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
  /** The blank rows above the conversation (a conversation shorter than the screen) that retired rows have not yet used. */
  pad: 0,
  /** The blank rows below the block that a terminal added when its screen grew and that nothing could take: the block is
   * that many rows above the last, until output fills them. */
  slack: 0,
  /** The screen height the block was last placed for: it ended on the last row of a screen this tall. */
  height: 0,
  /** After a settled change of height, the screen row the terminal's cursor report puts the block's first row on (undefined
   * when nothing was asked); the next frame consumes it. `measuring` holds frames back while the question is out. */
  found: undefined as number | undefined, measuring: false,
  /** The cursor report never came back after a change of height: where the block stands is unknown, so the next frame
   * erases and draws it from the cursor, with no vertical re-anchoring guessed (see anchorBlock). */
  lost: false,
  /** A modal surface (the board, the palette, a picker) is on screen: it is the whole visible screen, drawn from its top
   * row, and the conversation is not (see flushInlineFrame). `tail` is what the conversation had on the visible rows when
   * the surface opened, plus every row it retired since: they are written again, ahead of the block, when it closes. */
  page: false, tail: [] as string[],
};

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
  inlineBlock.slack = 0;
  return out;
}
