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

/** The rows of the phone's screen above its keyboard, as the phone last reported them (`CSI ?9701;<rows>t`); undefined until it has.
 * The phone terminal never resizes for its keyboard: the keyboard covers the bottom of a full-height screen. */
let phoneVisibleRows: number | undefined;
const visibleRowsListeners = new Set<() => void>();

export function setPhoneVisibleRows(rows: number | undefined): void {
  if (rows === phoneVisibleRows) return;
  phoneVisibleRows = rows;
  for (const listener of [...visibleRowsListeners]) listener();
}

/** Called when the phone reports a different number of visible rows. */
export function onPhoneVisibleRows(listener: () => void): () => void {
  visibleRowsListeners.add(listener);
  return () => { visibleRowsListeners.delete(listener); };
}

/** The rows a full-page surface (the conversation board) may take of a screen `rows` tall: all of them, except on the phone, where
 * the keyboard covers the bottom of the screen and the page ends where it begins, its last line (the composer) just above it. */
export function pageRows(rows: number, env: NodeJS.ProcessEnv = process.env): number {
  return phoneClient(env) && phoneVisibleRows !== undefined ? Math.max(1, Math.min(rows, phoneVisibleRows)) : rows;
}

/** Screen and saved lines, then home: replacing the conversation must leave none
 * of the previous one in a scrollback the client keeps. */
export const CLEAR_SCREEN_AND_SCROLLBACK = '\u001b[2J\u001b[3J\u001b[H';

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
