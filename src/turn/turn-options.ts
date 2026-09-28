/** Options supplied by any caller of a turn. */
import type { LiveTurnInputBroker } from './live-input.js';
import type { TurnObserver } from './observer.js';

export interface TurnRunOptions {
  liveInput?: LiveTurnInputBroker;
  queuedTurnId?: string;
  /** The interactive loop keeps ONE app-server / ACP child per open session
   * and closes it itself; headless sends stay one-shot. */
  persistentTransports?: boolean;
  /** Who is watching this turn, explicitly -- never read from a global. A
   * headless caller (CLI, daemon, a slash command with no terminal) omits
   * this and gets the plain stdout/emitHarnessOutput fallback every
   * TERMINAL.active check used to fall back to on its own. Any TurnObserver,
   * not necessarily a real terminal -- a worker's own broadcaster to its
   * attached clients satisfies this the same way TerminalHarnessPrompter
   * does, structurally, with nothing to import or subclass. */
  prompter?: TurnObserver;
}
