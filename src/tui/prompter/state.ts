/** The terminal prompter's constants and the shapes of its in-flight state, shared by the modules that act on it. */
import type { LiveTurnInputResult, TakeBackOutcome } from '../../turn/live-input.js';
import type { PickerOption } from '../../harness/prompter.js';
import type { CancelTrigger } from '../../worker/protocol.js';
import type { TurnClock } from '../../harness/protocol/activity-view.js';
import type { PaletteLayout } from '../option-picker.js';
import type { TurnUsage } from '../../harness/protocol/turn-usage.js';

export const EXIT_CONFIRM_MS = 2000;

/** How long a resize burst is given to finish before the settled redraw: the redraw waits this long after the LAST size
 * change. Full-screen, onResize has already drawn the FIRST size of the burst whole, and the settled redraw is the one that
 * follows the rest (and is skipped when nothing came after the first). Inline, onResize draws nothing, and the settled step
 * asks the terminal where its cursor is and draws the live block once. It only has to span the gap between the sizes of one
 * gesture: a dragged window sends them a few milliseconds apart, a phone's keyboard one size per change. A keystroke typed
 * during the wait is not held back, so this is not echo latency; inline, what a resize costs the person is this plus the
 * cursor report's round trip. */
export const RESIZE_SETTLE_MS = 100;

/** Inline only: how long the cursor report after a settled resize is waited for. A report that has not come by then is lost: the block is
 * drawn again relative to where it was last left. Frames are held back meanwhile, so this is also the longest a lost report
 * can stall output. */
export const CURSOR_REPORT_MS = 120;

/** The least a pending scroll moves in one frame, so a drain always finishes.
 * Claude Code's value. */
export const SCROLL_DRAIN_MIN = 4;

/** One frame, roughly: the gap between drains of an outstanding scroll. */
export const SCROLL_DRAIN_MS = 16;

/** Inline mode only: the rows kept for line numbers, and written again into the terminal's own scrollback on a reseed (the
 * terminal holds the conversation there; nothing is drawn from them). The full-screen view has no such limit: it renders
 * history from the persisted messages on demand (history-window.ts). */
export const INLINE_TRANSCRIPT_ROWS = 2000;
/** How often a drag held at the screen's edge scrolls the selection a line. */
export const SELECTION_SCROLL_MS = 60;

/** Lines of a running tool's newest output shown under its spinner. */
export const LIVE_OUTPUT_LINES = 3;

/** One paint's composer: its text and cursor, the prompt, and the options
 * (a picker's list or the slash palette) under it. */
export type ComposerFrame = {
  text: string; options: readonly PickerOption<string>[]; selected: number; prompt: string; cursor: number;
  palette?: PaletteLayout;
};
export const EMPTY_COMPOSER: ComposerFrame = { text: '', options: [], selected: 0, prompt: '› ', cursor: 0 };

/** Everything that exists only while a turn (or another wait: a download, a
 * shell command) is in flight. startWaiting creates it whole and stopWaiting
 * drops it whole, so no piece of one turn's state can outlive it into the
 * next. Its presence is what "running" means to the rest of the prompter. */
export type WaitingTurn = {
  /** What the band says the turn is doing. */
  label: string;
  /** What a Stop in flight says instead of `label`, which keeps the phase
   * the turn was in so that a Stop that ends nothing gives it back. */
  stopLabel?: string;
  /** Elapsed work time, excluding approvals. */
  clock: TurnClock;
  /** When the turn last did anything, for activity ordering and records. */
  activeAt: number;
  /** When answer text last arrived (a statusOrder tick): the status line says
   * "writing" until a call starts after it (answerWriting). */
  writingAt?: number;
  /** When the latest call started (a statusOrder tick). */
  callAt?: number;
  /** The usage this turn has reported so far, and the token count the
   * status line shows (stepped toward it each tick, never down). */
  usage?: TurnUsage;
  tokens?: number;
  /** The composer typed into while the turn runs. */
  draft: string;
  cursor: number;
  /** Ctrl+C, or Esc once the turn has an answer, has asked the turn to stop. */
  cancelled: boolean;
  cancel?: (restoreDraft: boolean, trigger?: CancelTrigger) => void;
  /** Put the oldest waiting user message into the chat (Enter again). */
  sendWaiting?: () => void;
  /** Take a waiting message back out of the queue (Esc): `removed` only when
   * it is the user's again -- not already on its way into the turn. */
  takeBack?: (id: string) => Promise<TakeBackOutcome>;
  /** Absent for a wait that takes no messages. */
  /** `id`: the message's identity, chosen by the window so its row matches its saved copy without guessing by words. */
  submit?: (text: string, id?: string) => Promise<LiveTurnInputResult>;
  command?: (text: string) => Promise<LiveTurnInputResult>;
  /** Stop showing the running turn without stopping it (Left, empty draft). */
  leave?: () => void;
  timer?: NodeJS.Timeout;
  stopInput?: () => void;
  /** Drawn before the turn's own controls exist (turnStarting): what is
   * typed is kept for it, and an interrupt is passed on once it can be. */
  early?: { interrupt?: { restoreDraft: boolean; trigger?: CancelTrigger } };
  /** Told when this turn's display ends, by whoever ends it: the follow of a
   * worker's turn (worker/turn-bridge.ts) lives exactly as long as the
   * display it drives. When the two could disagree, the display ended and the
   * follow kept waiting for the worker -- nothing read a key until the
   * worker's turn ended, an hour on with sub-agents running. */
  ended?: () => void;
};
