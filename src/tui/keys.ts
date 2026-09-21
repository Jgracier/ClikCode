/**
 * How a keystroke is spelled: paste brackets, the kitty protocol flag, and the
 * one internal spelling for "insert a newline".
 *
 * This is vocabulary two other concerns share -- the prompter, which asks the
 * terminal for these modes, and the composer editor, which decides what a key
 * does to a line. Holding it here is what keeps those two from importing each
 * other.
 */
import { sanitizeTerminalText } from './render/text.js';

function environmentFlag(...values: (string | undefined)[]): boolean {
  return values.some((value) => {
    const normalized = (value ?? '').trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
  });
}

export const PASTE_START = '\u001b[200~';
export const PASTE_END = '\u001b[201~';

/** The text of a pasted key as it should enter a draft, or undefined for an
 * ordinary keystroke. Terminals deliver a pasted line break as a bare `\r`
 * (and Windows sources as `\r\n`), which drew as one row that kept rewinding
 * over itself instead of a multi-line draft; tabs and any escape sequences
 * smuggled inside the paste are neutralised by the same sanitizer. */
export function pastedText(key: string): string | undefined {
  return key.startsWith(PASTE_START) && key.endsWith(PASTE_END)
    ? sanitizeTerminalText(key.slice(PASTE_START.length, key.length - PASTE_END.length))
    : undefined;
}

/** Kitty keyboard protocol, "disambiguate escape codes" flag only. It is what
 * makes Shift+Enter distinguishable from Enter. It also re-encodes Esc and
 * every Ctrl/Alt chord as `CSI code ; modifiers u`, which normalizeTerminalKey
 * folds back into the legacy bytes the rest of this file matches on. */
export const PUSH_KITTY_KEYBOARD = '\u001b[>1u';
export const POP_KITTY_KEYBOARD = '\u001b[<u';
/** One internal spelling for "insert a newline" however the terminal said it:
 * Alt+Enter, Shift+Enter via CSI u, or xterm's modifyOtherKeys form. */
export const NEWLINE_KEY = '\u001b\r';

/** Pushing the flag is only safe where it is understood: an unaware terminal
 * may echo the sequence, and inside tmux the pop never reaches the outer
 * terminal, leaving the user's shell receiving CSI-u for Ctrl+C. */
export function kittyKeyboardSafe(environment: NodeJS.ProcessEnv = process.env): boolean {
  if (environmentFlag(environment.CLIKCODE_NO_KITTY_KEYBOARD)) return false;
  if (environment.TMUX || environment.STY || /^(?:screen|tmux)/.test(environment.TERM ?? '')) return false;
  const program = (environment.TERM_PROGRAM ?? '').toLowerCase();
  return Boolean(environment.KITTY_WINDOW_ID || environment.GHOSTTY_RESOURCES_DIR || environment.WEZTERM_PANE
    || /^(?:xterm-kitty|xterm-ghostty|foot|alacritty|wezterm)/.test(environment.TERM ?? '')
    || program === 'wezterm' || program === 'ghostty' || program === 'kitty');
}
