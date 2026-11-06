/** Inline-history mode: the conversation is printed once into the terminal's own
 * scrollback and only the composer and status block is redrawn, with relative
 * cursor motion, at the bottom. No alternate screen and no mouse reporting, so
 * a touch scrolls the client's own scrollback.
 *
 * Which mode runs, first match wins:
 *   1. CLIKCODE_INLINE=1 / 0 forces inline / full-screen.
 *   2. CLIKDEPLOY_CLIENT=mobile (the ClikDeploy phone terminal) is inline.
 *   3. tmux / screen (TMUX or STY set, TERM starting with screen or tmux) is inline: a
 *      multiplexer swallows the mouse and alternate screen whatever sits behind it.
 *   4. TERM=dumb or linux (the console has no reliable alternate screen or mouse) is inline.
 *   5. A known good local terminal (TERM_PROGRAM iTerm.app, Apple_Terminal, WezTerm, ghostty,
 *      kitty, vscode, Alacritty; or the matching TERM) is full-screen, even over ssh.
 *   6. Over ssh (SSH_CONNECTION or SSH_TTY): inline when narrower than 100 columns or
 *      TERM_PROGRAM is unknown (the local terminal is not known to be a good one).
 *   7. Otherwise full-screen.
 * `columns` is the terminal width, when known. */
const GOOD_TERMINAL_PROGRAMS = new Set(['iterm.app', 'apple_terminal', 'wezterm', 'ghostty', 'kitty', 'vscode', 'alacritty']);
const GOOD_TERMS = new Set(['xterm-kitty', 'alacritty', 'xterm-ghostty', 'wezterm']);

export function inlineHistoryMode(env: NodeJS.ProcessEnv = process.env, columns: number | undefined = process.stdout.columns): boolean {
  if (env.CLIKCODE_INLINE === '1') return true;
  if (env.CLIKCODE_INLINE === '0') return false;
  if (phoneClient(env)) return true;
  const term = (env.TERM ?? '').toLowerCase();
  if (env.TMUX || env.STY || term.startsWith('screen') || term.startsWith('tmux')) return true;
  if (term === 'dumb' || term === 'linux') return true;
  const program = (env.TERM_PROGRAM ?? '').toLowerCase();
  const good = GOOD_TERMINAL_PROGRAMS.has(program) || GOOD_TERMS.has(term);
  if (good) return false;
  if (env.SSH_CONNECTION || env.SSH_TTY) return (columns ?? 0) < 100 || !program;
  return false;
}

export const phoneClient = (env: NodeJS.ProcessEnv = process.env): boolean => env.CLIKDEPLOY_CLIENT === 'mobile';

/** The share of the screen the phone's keyboard leaves visible, less a margin (the keyboard covers up to 43%). */
const PHONE_PAGE_SHARE = 0.55;

/** The rows a full-page surface (the conversation board) may take of a screen `rows` tall. The ClikDeploy phone
 * terminal never resizes for its keyboard: it slides the whole terminal up by the keyboard's height, which is up to
 * 43% of the screen, so a page taller than the rest has its top cut off above the screen. */
export function pageRows(rows: number, env: NodeJS.ProcessEnv = process.env): number {
  return phoneClient(env) ? Math.floor(rows * PHONE_PAGE_SHARE) : rows;
}

/** Screen and saved lines, then home: replacing the conversation must leave none
 * of the previous one in a scrollback the client keeps. */
export const CLEAR_SCREEN_AND_SCROLLBACK = '\u001b[2J\u001b[3J\u001b[H';

/** Where the last inline frame left the cursor: the rows of the live block it
 * drew and the row within it the cursor is parked on. */
export const inlineBlock = {
  rows: 0, cursorRow: 0, clearNext: false, last: '', liveRows: [] as string[], columns: 0,
  /** Bottom anchoring: the screen row the block starts on and the screen height it was
   * drawn for, while the block ends on the last row (undefined when its place is unknown),
   * and the blank rows above the conversation that have not yet been filled. */
  top: undefined as number | undefined, height: 0, pad: 0,
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
  inlineBlock.top = undefined;
  return out;
}
