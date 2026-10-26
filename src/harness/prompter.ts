/** The contract between a harness and whatever is drawing the screen: what
 * it may report as activity, what it may ask to be shown, and what it may
 * ask the user to choose. Implemented by tui/prompter.ts, and by nothing
 * else -- a headless run passes a prompter that answers without drawing. */

import type { ApprovalPreview } from '../tui/render/approval-block.js';
import type { HarnessSession } from '../session/model.js';

/** What a tool call DOES, as against what state it is in. Deliberately small:
 * five categories every harness's tools fall into, or nothing at all. */
export type ToolCategory = 'read' | 'edit' | 'run' | 'search' | 'fetch';

export interface HarnessActivityEvent {
  kind: 'thinking' | 'tool-start' | 'tool-done' | 'tool-error';
  label: string;
  /** Absent whenever the evidence does not settle it. A tool nobody has
   * catalogued renders exactly as it did before this existed, rather than
   * being assigned a plausible-looking category. */
  category?: ToolCategory;
  /** The turn is blocked on a sub-agent, not on a read or a shell command.
   * Set from the envelope (Codex collab calls, an agent-shaped tool name)
   * rather than guessed from prose. */
  agent?: boolean;
  /** For a sub-agent's call: how many tools the sub-agent has used under it,
   * as Claude Code counts them ("12 tool uses"). Set by the display. */
  childTools?: number;
  /** For a sub-agent's call: the tokens it spent, where the harness reports
   * them on its result (Claude Code's Task result, `totalTokens`). */
  childTokens?: number;
  /** The row's emission sequence: assigned ONCE by the worker when it first
   * saw the row, strictly increasing within a turn (turn/mark-sequence.ts).
   * With `responseOffset` it is the row's place (activity-view.ts orderMarks).
   * A later frame of the same call keeps the first one. Absent on turns
   * saved before it existed: readers derive it from the record's position. */
  seq?: number;
  /** For a sub-agent's call: the ids of the child calls already counted in
   * `childTools`, so "N tool uses" counts calls, not the several frames each
   * call arrives in. Live only -- never saved or sent (CallIdSet.toJSON). */
  childCallIds?: ReadonlySet<string>;
  /** Set when this call belongs to a sub-agent (Claude's parent_tool_use_id).
   * It is journaled for recovery; the parent agent row carries its display. */
  parentId?: string;
  /** The vendor's own id for the sub-agent this row stands for (a Claude
   * agentId), where its frames publish one. Codex's is in the row id
   * (`agent:<threadId>`). Read by subAgentRef (protocol/activity-normalize.ts). */
  agentId?: string;
  /** Vendor tool-call identity, when emitted, lets the TUI update an in-flight
   * row instead of appending a detached completion at the bottom. */
  id?: string;
  /** The call as the vendor made it: its own tool name and arguments
   * (bounded, turn/turn-activities.ts). Never drawn -- `label` is the row.
   * Kept so another provider can be handed the call itself rather than its
   * one-line row (session/canonical.ts). Absent on calls recorded before it
   * was kept, and where the stream carries no input. */
  call?: { name: string; input?: Record<string, unknown> };
  /** Bounded partial/final tool output supplied by the native event stream. */
  output?: string[];
  /** Lines of output the producer dropped to bound `output`; the renderer
   * counts them in its "… N more lines" rather than a fake line saying so. */
  outputOmitted?: number;
  /** `output` is the END of the tool's output (a running command's newest
   * lines), so the omitted lines came before it. Otherwise it is the start. */
  outputTail?: boolean;
  /** The first lines of an output cut to its tail (`outputTail` with lines
   * omitted): what a long command set out to do, shown above how it ended. */
  outputHead?: string[];
  /** Only ever populated where the harness's own JSON genuinely carries the
   * before/after text (confirmed so far: Claude Code's Edit/Write tool_use
   * blocks) -- never synthesized from a "files updated" style event that
   * doesn't actually include the changed content. Each side is already
   * capped to a few lines before this is built; the activity trail below is
   * a 5-line rolling window (see TerminalHarnessPrompter.activity), not a
   * scrollback viewer, so an uncapped diff would just silently lose its
   * earlier lines to the window sliding past them, not show a real "more"
   * indicator -- capping here means the +N truncation notice is honest. */
  diff?: import('../agent/line-diff.js').FileDiff[];
  /** How long the call ran, where the vendor (or ClikCode's own loop)
   * reports it. Only on a completion. */
  durationMs?: number;
  /** A finished command's exit code, where the vendor reports one. */
  exitCode?: number;
  /** A call still open when the user stopped its turn: closed as a
   * `tool-error` (it did not finish), but it did not fail either, and says
   * so. Kept in the saved turn, so a reopened chat shows it stopped too. */
  stopped?: boolean;
}

export interface HarnessPrompter {
  question(
    prompt: string,
    commands?: readonly PickerOption<string>[],
    /** `secret`: drawn as dots and kept out of history (an API key). */
    settings?: { cancellable?: boolean; rightArrowPalette?: boolean; leftArrowCommand?: string; secret?: boolean },
  ): Promise<string>;
  select?<T>(
    title: string,
    options: readonly PickerOption<T>[],
    onAction?: (value: T, action: string) => Promise<void>,
    settings?: PickerSettings<T>,
  ): Promise<T | undefined>;
  /** The full-page conversation board (tui/conversation-board.ts), where a
   * terminal can draw one. */
  board?(settings: import('../tui/conversation-board.js').ConversationBoardSettings): Promise<import('../tui/conversation-board.js').BoardResult | undefined>;
  /** `journal`: whether something still runs the conversation's turn journal
   * (`pendingTurn`). Unsaid, it may be running, and is never drawn as ended. */
  render?(session: HarnessSession, account?: string, journal?: JournalState): void;
  /** The prompt this client has just submitted, or undefined for a synthetic
   * turn that shows none. Held until the turn ends: see
   * tui/render/pending-prompt.ts for why a snapshot cannot carry it. */
  submitted?(prompt: string | undefined): void;
  response?(text: string, mode?: 'append' | 'replace'): void;
  approval?(title: string, detail?: string, preview?: ApprovalPreview, rule?: string, signal?: AbortSignal, callId?: string): Promise<boolean | 'always'>;
  /** A vendor's question, drawn where approvals are. Absent where nothing can
   * ask; the turn then cancels it with a notice. */
  askQuestions?(request: import('./events/question.js').HarnessQuestionRequest, signal?: AbortSignal): Promise<import('./events/question.js').HarnessQuestionResult>;
  activityEvent?(event: HarnessActivityEvent): void;
  panel?(title: string, body: string): void;
  /** A line in the conversation outside any turn's own output. */
  activity?(message: string): void;
  /** Where a vendor sign-in shows its link, code and questions
   * (commands/account.ts withSignIn): the CLI's band, the VS Code card. */
  signInScreen?(name: string): import('../gateway/login/vendor-sign-in.js').SignInScreen;
  close(): void;
}

/** What a render knows of the turn journal (`pendingTurn`) it carries: a
 * worker is still running it (with this prompt, when known), or nothing is
 * and it is an interrupted turn. */
/** `following`: the caller follows this running turn at once. Nothing is painted for it here -- its
 * first frame is the follow's, which replaces whatever is on screen (the board, or the chat as it was)
 * in one change. An idle composer painted first is a frame with the chat missing. */
export type JournalState = { running: false } | { running: true; prompt?: string; following?: true };

export type MessageBlock =
  | { kind: 'paragraph'; text: string; quoteDepth: number; indent: number; sourceEnd: number; blockBoundary?: boolean }
  | { kind: 'heading'; text: string; level: number; quoteDepth: number; sourceEnd: number; blockBoundary?: boolean }
  | { kind: 'rule'; quoteDepth: number; sourceEnd: number; blockBoundary?: boolean }
  /** `open`: a fence whose closing line has not arrived yet, so a blank line
   * inside it does not end it. `before`: the lines of the same fence already
   * written above these (a fence retired a line at a time), which decide how
   * these are highlighted -- inside a comment or a string, say -- and
   * `headerless` leaves out the language row they already had. */
  | { kind: 'code'; lines: string[]; language?: string; quoteDepth: number; indent: number; sourceEnd: number; blockBoundary?: boolean; open?: boolean; before?: readonly string[]; headerless?: boolean }
  | { kind: 'table'; header: string[]; rows: string[][]; align: Array<'left' | 'center' | 'right' | null>; quoteDepth: number; sourceEnd: number; blockBoundary?: boolean }
  | { kind: 'list-item'; text: string; depth: number; ordered: boolean; number?: number; task: boolean; checked?: boolean; quoteDepth: number; sourceEnd: number; blockBoundary?: boolean };

/** Everything a list takes beyond its rows: where it starts, what Left and
 * Esc do, and rows that arrive after it opens. */
export interface PickerSettings<T> {
  onBack?: () => void;
  /** The row to start on: the current value, or the row a sub-menu was
   * opened from. Absent or not listed, the first. */
  startAt?: T;
  onEscape?: () => void;
  refreshedOptions?: () => readonly PickerOption<T>[];
  /** Search a remote catalog as the user types into this list. */
  onFilter?: (query: string) => Promise<readonly PickerOption<T>[]>;
  refresh?: Promise<unknown> | readonly Promise<unknown>[];
  /** Rows the list may use, when more than the default suits it. */
  rows?: number;
  /** Count real records when the list also contains an action row. */
  totalItems?: number;
}

export interface PickerOption<T> {
  label: string;
  detail?: string;
  value: T;
  /** Alternate values represented by the same logical row (for example a
   * conversation's provider-history branches). Opened with Tab. */
  alternates?: readonly { label: string; value: T }[];
  /** Non-destructive maintenance actions such as reauthentication. */
  actions?: readonly { label: string; value: string }[];
  /** Destructive row action. The terminal picker confirms it first, unless
   * `undoable`: one that can be taken back in a step (a sign-out, undone by
   * signing in) runs at once, as /logout does -- fewest steps. */
  deleteAction?: { label: string; value: string; undoable?: boolean };
  /** Slash-palette rows: argument hint shown after the label, and the section
   * the row belongs to. Optional; a prompter that ignores them still works. */
  argHint?: string;
  group?: string;
  /** A setting with only a few values, shown and changed IN the list rather
   * than behind a second screen: the row shows every choice with the current
   * one marked, and Enter or Right Arrow moves to the next, applied at once,
   * with the list staying open. For a setting with more values than fit on a
   * row, leave this out and let the row open its own list. */
  inline?: {
    choices: readonly { label: string; value: string }[];
    current: string;
    apply(value: string): Promise<void>;
  };
  /** A conversation row's glyph (conversation-activity.ts): a turn is
   * running in it (an animated spinner), or is waiting on the user (a dot). */
  activity?: 'working' | 'needs-you';
}
