/**
 * The screen ClikCode shows while a vendor is signing in.
 *
 * Handing the terminal to the vendor means the user reads whatever that
 * vendor prints. That ranges from Claude Code's tidy four lines to
 * Antigravity's raw JSON dump, and on a phone the useful part -- the link and
 * the place to paste a code back -- is buried in it. Once a sign-in URL has
 * been seen there is nothing left worth reading, so ClikCode paints its own
 * panel over it: the shortened link, and one clean field.
 *
 * Nothing is thrown away. The vendor's output keeps accumulating behind the
 * panel; Ctrl-O reveals it, and a failed login prints its tail unprompted,
 * because a login that fails for an unexpected reason is exactly when the
 * raw text matters.
 *
 * This module is pure: it renders strings and interprets keystrokes. The
 * process, the pty and the terminal belong to the caller.
 */

/** Typed input is a credential. It is echoed masked -- enough to see that a
 * paste landed and how long it was, without putting an API key on a screen
 * someone may be holding up in public. */
export function maskSecret(value: string): string {
  return value ? `${'•'.repeat(Math.min(value.length, 32))}${value.length > 32 ? `… (${value.length})` : ''}` : '';
}

export type LoginKeyEvent =
  | { kind: 'update' }
  | { kind: 'submit'; value: string }
  | { kind: 'cancel' }
  | { kind: 'reveal' }
  | { kind: 'ignored' };

const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';

/** Keystrokes to a field's contents. Handles bracketed paste as one unit:
 * a phone pasting a 200-character key sends it as one burst wrapped in paste
 * markers, and those markers must never end up in the credential. */
export class LoginField {
  private value = '';
  private pasting = false;

  get contents(): string { return this.value; }

  push(chunk: string): LoginKeyEvent {
    let changed = false;
    let index = 0;
    while (index < chunk.length) {
      if (chunk.startsWith(PASTE_START, index)) { this.pasting = true; index += PASTE_START.length; continue; }
      if (chunk.startsWith(PASTE_END, index)) { this.pasting = false; index += PASTE_END.length; continue; }
      const character = chunk[index]!;
      index += 1;
      // Inside a paste, a newline is part of the pasted text, not a submit:
      // a copied credential often carries a trailing newline, and submitting
      // on it would truncate a multi-line paste.
      if ((character === '\r' || character === '\n') && !this.pasting) {
        const value = this.value.trim();
        this.value = '';
        return { kind: 'submit', value };
      }
      if (character === '\r' || character === '\n') continue;
      if (character === '\u0003') return { kind: 'cancel' };
      if (character === '\u000f') return { kind: 'reveal' };
      if (character === '\u0015') { this.value = ''; changed = true; continue; }
      if (character === '\u007f' || character === '\b') {
        if (this.value) { this.value = this.value.slice(0, -1); changed = true; }
        continue;
      }
      // An escape sequence (a cursor key, a mouse report) must be consumed
      // whole. Skipping only the ESC byte leaves its tail -- '[D' for Left --
      // to be typed into the credential as printable text.
      if (character === '\u001b') {
        const rest = chunk.slice(index);
        const sequence = /^(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/.exec(rest);
        index += sequence ? sequence[0].length : 0;
        continue;
      }
      // Any other control character is one this field has no use for; a
      // credential is printable.
      if (character < ' ') continue;
      this.value += character;
      changed = true;
    }
    return changed ? { kind: 'update' } : { kind: 'ignored' };
  }
}

export interface LoginScreenState {
  displayName: string;
  shortUrl: string;
  /** Whether a browser was opened on this machine. */
  opened: boolean;
  /** Whether the clipboard copy was attempted (OSC 52 is write-only: the
   * terminal either honours it or silently does not, and we cannot tell). */
  copied: boolean;
  field: string;
  /** Set once the vendor process has exited while the panel was up. */
  finished?: 'ok' | 'failed';
  note?: string;
}

const RESET = '\u001b[0m';
const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';
const CYAN = '\u001b[36m';

/** The panel, as a block of lines. Rendering is separate from painting so a
 * test can read it without a terminal. */
export function renderLoginScreen(state: LoginScreenState): string[] {
  const lines: string[] = [];
  lines.push(`${BOLD}Sign in to ${state.displayName}${RESET}`);
  lines.push('');
  lines.push(`  ${CYAN}${state.shortUrl}${RESET}`);
  lines.push('');
  if (state.copied) lines.push(`  ${DIM}Copied to your clipboard.${RESET}`);
  lines.push(state.opened
    ? `  ${DIM}A browser should have opened here.${RESET}`
    : `  ${DIM}Open it on your phone, then come back.${RESET}`);
  lines.push('');
  if (state.finished === 'ok') {
    lines.push(`  ${DIM}Signed in.${RESET}`);
    return lines;
  }
  if (state.finished === 'failed') {
    lines.push(`  ${DIM}Sign-in did not complete — the vendor's output follows.${RESET}`);
    return lines;
  }
  lines.push(`  Paste the code or key here, then press Enter:`);
  lines.push(`  ${BOLD}▸${RESET} ${maskSecret(state.field)}`);
  lines.push('');
  lines.push(`  ${DIM}Nothing to paste? Wait — it may finish in the browser.${RESET}`);
  lines.push(`  ${DIM}Ctrl-O shows the raw output · Ctrl-C cancels${RESET}`);
  if (state.note) lines.push(`  ${DIM}${state.note}${RESET}`);
  return lines;
}
