/**
 * Who is currently drawing the screen.
 *
 * The turn loop, the command surface and the non-interactive reporter all need
 * to know whether a human is watching a prompter right now -- a turn streams
 * deltas into it, a slash command renders a panel through it, and with no
 * prompter both fall back to plain stdout. One mutable reference, held here so
 * that none of those three has to import the other two to reach it.
 */
import type { TerminalHarnessPrompter } from './prompter.js';

export const TERMINAL: {
  /** The prompter on screen, or undefined when output is headless. */
  active?: TerminalHarnessPrompter;
  /** Panels emitted through the TUI; the loop pauses after a command that showed one. */
  panelsShown: number;
} = { panelsShown: 0 };

