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
  /** Set when this call belongs to a sub-agent (Claude's parent_tool_use_id).
   * It is not its own row; the parent agent row carries it. */
  parentId?: string;
  /** Vendor tool-call identity, when emitted, lets the TUI update an in-flight
   * row instead of appending a detached completion at the bottom. */
  id?: string;
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
  /** Set when this row is another provider working inside the host's turn.
   * The host chat paints that provider's name; the model is not given the
   * provider's transcript. */
  swarm?: { provider: string; displayName: string; role: 'explore' | 'implement' | 'review'; step?: string; usageLeft?: number };
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
  render?(session: HarnessSession, account?: string, notice?: string, journal?: JournalState): void;
  /** The prompt this client has just submitted, or undefined for a synthetic
   * turn that shows none. Held until the turn ends: see
   * tui/render/pending-prompt.ts for why a snapshot cannot carry it. */
  submitted?(prompt: string | undefined): void;
  response?(text: string, mode?: 'append' | 'replace'): void;
  approval?(title: string, detail?: string, preview?: ApprovalPreview, rule?: string): Promise<boolean | 'always'>;
  activityEvent?(event: HarnessActivityEvent): void;
  panel?(title: string, body: string): void;
  /** A line in the conversation outside any turn's own output. */
  activity?(message: string): void;
  /** Where a vendor sign-in shows its link, code and questions
   * (commands/account.ts withSignIn): the CLI's band, the VS Code card. */
  signInScreen?(name: string): import('../gateway/login/vendor-sign-in.js').SignInScreen;
  /** A one-line confirmation under the composer that clears itself:
   * "Effort set to High". Where nothing can show one, nothing is said. */
  notice?(text: string): void;
  close(): void;
}

/** What a render knows of the turn journal (`pendingTurn`) it carries: a
 * worker is still running it (with this prompt, when known), or nothing is
 * and it is an interrupted turn. */
export type JournalState = { running: false } | { running: true; prompt?: string };

export type MessageBlock =
  | { kind: 'paragraph'; text: string; quoteDepth: number; indent: number; sourceEnd: number; blockBoundary?: boolean }
  | { kind: 'heading'; text: string; level: number; quoteDepth: number; sourceEnd: number; blockBoundary?: boolean }
  | { kind: 'rule'; quoteDepth: number; sourceEnd: number; blockBoundary?: boolean }
  | { kind: 'code'; lines: string[]; language?: string; quoteDepth: number; indent: number; sourceEnd: number; blockBoundary?: boolean }
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
  /** Destructive row action. The terminal picker always confirms it first. */
  deleteAction?: { label: string; value: string };
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
  /** A list inside this row, opened with Left Arrow -- a conversation's
   * running sub-agents. Left from inside it comes back out. */
  inner?: { title: string; options: readonly PickerOption<T>[] };
  /** A turn is running in this row's conversation, at this pace: a list that
   * can animate draws a spinner in front of the label, one that cannot a dot. */
  working?: 'flowing' | 'slowing' | 'stuck';
}
