/** The terminal prompter's constants and the shapes of its in-flight state, shared by the modules that act on it. */
import type { LiveTurnInputResult, TakeBackOutcome } from '../../turn/live-input.js';
import type { PickerOption } from '../../harness/prompter.js';
import type { TurnClock } from '../../harness/protocol/activity-view.js';
import type { PaletteLayout } from '../option-picker.js';
import type { TurnUsage } from '../../harness/protocol/turn-usage.js';

export const EXIT_CONFIRM_MS = 2000;

/** How long a resize burst is given to finish before the settled redraw. A
 * phone dismissing its keyboard emits several SIGWINCHes a few tens of
 * milliseconds apart; this is longer than that gap. The first size of a
 * burst is drawn at once (onResize); this only decides when the burst is over. */
export const RESIZE_SETTLE_MS = 120;

/** The least a pending scroll moves in one frame, so a drain always finishes.
 * Claude Code's value. */
export const SCROLL_DRAIN_MIN = 4;

/** One frame, roughly: the gap between drains of an outstanding scroll. */
export const SCROLL_DRAIN_MS = 16;

export const ENTER_ALTERNATE_SCREEN = '\u001b[?1049h\u001b[2J\u001b[H';

/** Rows kept above the viewport so scrolling back inside a conversation still
 * has somewhere to scroll to. */
export const ALTERNATE_TRANSCRIPT_ROWS = 2000;
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
  /** Elapsed less approvals, and the last delta or event, which is what
   * "stalled" means (see activity-view.ts). */
  clock: TurnClock;
  /** When the turn last did anything -- a word, a thought, a call -- or an
   * approval was answered: quiet past turn-pace's threshold and the spinner
   * turns yellow, by the same rule as a stalled row in the conversation list. */
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
  cancel?: (restoreDraft: boolean) => void;
  /** Put the oldest waiting user message into the chat (Enter again). */
  sendWaiting?: () => void;
  /** Take a waiting message back out of the queue (Esc): `removed` only when
   * it is the user's again -- not already on its way into the turn. */
  takeBack?: (id: string) => Promise<TakeBackOutcome>;
  /** Absent for a wait that takes no messages. */
  submit?: (text: string) => Promise<LiveTurnInputResult>;
  command?: (text: string) => Promise<LiveTurnInputResult>;
  /** Stop showing the running turn without stopping it (Left, empty draft). */
  leave?: () => void;
  timer?: NodeJS.Timeout;
  stopInput?: () => void;
  /** Drawn before the turn's own controls exist (turnStarting): what is
   * typed is kept for it, and an interrupt is passed on once it can be. */
  early?: { interrupt?: { restoreDraft: boolean } };
  /** Told when this turn's display ends, by whoever ends it: the follow of a
   * worker's turn (worker/turn-bridge.ts) lives exactly as long as the
   * display it drives. When the two could disagree, the display ended and the
   * follow kept waiting for the worker -- nothing read a key until the
   * worker's turn ended, an hour on with sub-agents running. */
  ended?: () => void;
};
