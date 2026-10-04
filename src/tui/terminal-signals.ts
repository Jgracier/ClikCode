/** What the terminal around the UI is told, beyond the screen itself: the
 * window title, a progress indicator, whether it has focus, and a
 * notification when something needs the user and they have looked away.
 * Grok Build and Claude Code both do all four; these are their sequences.
 *
 * Builders and decisions only, no writing: the prompter writes them (only
 * to a TTY), and restore.ts takes them back on every way out. */

/** Save the title the shell had, and put it back (xterm's title stack). A
 * terminal without the stack ignores both. */
export const PUSH_TITLE = '\u001b[22;0t';
export const POP_TITLE = '\u001b[23;0t';

/** `CSI ?1004h`: the terminal reports focus in (`CSI I`) and out (`CSI O`). */
export const FOCUS_REPORTING_ON = '\u001b[?1004h';
export const FOCUS_REPORTING_OFF = '\u001b[?1004l';

/** Unfocused at least this long before a notification is worth sending:
 * a glance at another window is not looking away (Grok's rule). */
export const NOTIFY_AFTER_UNFOCUSED_MS = 3000;

/** Text fit for an OSC string: no control characters (one would end the
 * sequence early, or start another), one line, bounded. */
function oscText(text: string, limit: number): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return [...clean].slice(0, limit).join('');
}

/** OSC 0: the window and tab title. */
export function titleSequence(title: string): string {
  return `\u001b]0;${oscText(title, 80)}\u0007`;
}

/** OSC 9;4: the tab's progress indicator -- indeterminate while a turn runs,
 * cleared when it ends (Windows Terminal, ConEmu, Ghostty, iTerm2). */
export function progressSequence(running: boolean): string {
  return running ? '\u001b]9;4;3;\u0007' : '\u001b]9;4;0;\u0007';
}

/** OSC 9 with a message -- a desktop notification where the terminal shows
 * them -- and a bell for every other terminal. A message that begins with a
 * digit and `;` would read as another OSC 9 command (`4;` is progress), so
 * it never does. */
export function notifySequence(message: string): string {
  const text = oscText(message, 200).replace(/^(\d+);/, '$1:');
  return `\u001b]9;${text}\u0007\u0007`;
}

/** Focus as the terminal last reported it. `undefined` until it reports at
 * all: a terminal that never says is never assumed to be looked away from. */
export type FocusState = { focused?: boolean; since: number };

/** Whether something needing the user is worth a notification: the
 * terminal has said it lost focus, NOTIFY_AFTER_UNFOCUSED_MS ago or more. */
export function shouldNotify(focus: FocusState, now: number): boolean {
  return focus.focused === false && now - focus.since >= NOTIFY_AFTER_UNFOCUSED_MS;
}

/** The conversation's name, and while a turn runs, that it is working --
 * or waiting for the user, which is worth seeing from another tab. Nothing
 * that changes within a turn: a spinner or the current call in the title
 * rewrote it every tick, and the tab's progress indicator already moves. */
export function windowTitle(state: { running: boolean; asking?: boolean; name?: string }): string {
  const name = state.name?.trim() || 'ClikCode';
  if (!state.running) return name;
  return `${state.asking ? 'waiting for you' : 'working'} · ${name}`;
}
