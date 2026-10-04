/** OSC 8 hyperlinks, where the terminal supports them. */



export const HYPERLINK_CLOSE = '\u001b]8;;\u001b\\';

export const hyperlinkOpen = (href: string): string => `\u001b]8;;${href}\u001b\\`;

/** OSC 8 is only emitted where it is known to render as a link. Elsewhere it
 * is at best ignored and at worst printed, so the fallback is `text (href)`.
 * tmux forwards OSC 8 only with passthrough configured, which cannot be
 * detected from inside it; CLIKCODE_HYPERLINKS=1 opts in there. */
function hyperlinksSupported(environment: NodeJS.ProcessEnv = process.env, isTty = Boolean(process.stdout.isTTY)): boolean {
  const flag = (value: string | undefined): boolean => value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
  if (flag(environment.CLIKCODE_NO_HYPERLINKS)) return false;
  if (!isTty || (environment.TERM ?? '').toLowerCase() === 'dumb') return false;
  if (flag(environment.CLIKCODE_HYPERLINKS) || flag(environment.FORCE_HYPERLINK)) return true;
  if (environment.TMUX || environment.STY || /^(?:screen|tmux)/.test(environment.TERM ?? '')) return false;
  const program = (environment.TERM_PROGRAM ?? '').toLowerCase();
  if (['iterm.app', 'wezterm', 'vscode', 'ghostty', 'hyper', 'kitty', 'rio', 'warpterminal'].includes(program)) return true;
  if (environment.KITTY_WINDOW_ID || environment.WT_SESSION || environment.KONSOLE_VERSION || environment.DOMTERM) return true;
  if (Number(environment.VTE_VERSION ?? 0) >= 5000) return true;
  return /^(?:xterm-kitty|xterm-ghostty|foot|alacritty|wezterm|contour)/.test(environment.TERM ?? '');
}

let hyperlinksEnabled: boolean | undefined;

/** Resolved once per process unless something sets it explicitly. */
export const linksOn = (): boolean => hyperlinksEnabled ?? (hyperlinksEnabled = hyperlinksSupported());

/** An SGR whose parameters include 4, underline on. */
const UNDERLINE_ON = /\u001b\[(?:[0-9;]*;)?4[;m]/;

/** A hard-wrapped link can leave its hyperlink open at the end of a row. Rows
 * are repainted independently, so the attribute must never outlive its row.
 * The same is true of chalk's underline SGR: wrapWords hard-breaks a long
 * link label mid-span, and without a close here every later row in the chat
 * stayed underlined. */
export function closeOpenHyperlink(row: string): string {
  const last = row.lastIndexOf('\u001b]8;');
  const closedLink = last === -1 || row.startsWith(HYPERLINK_CLOSE, last) ? row : `${row}${HYPERLINK_CLOSE}`;
  // Nearly every row never turns underline on, and then none is left open.
  if (!UNDERLINE_ON.test(closedLink)) return closedLink;
  let underline = false;
  for (const match of closedLink.matchAll(/\u001b\[([0-9;]*)m/g)) {
    const params = match[1]!.split(';').filter(Boolean).map(Number);
    if (params.length === 0 || params.includes(0)) { underline = false; continue; }
    if (params.includes(4)) underline = true;
    if (params.includes(24)) underline = false;
  }
  return underline ? `${closedLink}\u001b[24m` : closedLink;
}
