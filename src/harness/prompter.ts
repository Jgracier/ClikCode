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
  /** Vendor tool-call identity, when emitted, lets the TUI update an in-flight
   * row instead of appending a detached completion at the bottom. */
  id?: string;
  /** Bounded partial/final tool output supplied by the native event stream. */
  output?: string[];
  /** Only ever populated where the harness's own JSON genuinely carries the
   * before/after text (confirmed so far: Claude Code's Edit/Write tool_use
   * blocks) -- never synthesized from a "files updated" style event that
   * doesn't actually include the changed content. Each side is already
   * capped to a few lines before this is built; the activity trail below is
   * a 5-line rolling window (see TerminalHarnessPrompter.activity), not a
   * scrollback viewer, so an uncapped diff would just silently lose its
   * earlier lines to the window sliding past them, not show a real "more"
   * indicator -- capping here means the +N truncation notice is honest. */
  diff?: { removed: string[]; added: string[] };
}

export interface HarnessPrompter {
  question(
    prompt: string,
    commands?: readonly PickerOption<string>[],
    settings?: { cancellable?: boolean; rightArrowPalette?: boolean },
  ): Promise<string>;
  select?<T>(
    title: string,
    options: readonly PickerOption<T>[],
    onAction?: (value: T, action: string) => Promise<void>,
    settings?: {
      onBack?: () => void;
      onEscape?: () => void;
      refreshedOptions?: () => readonly PickerOption<T>[];
      refresh?: Promise<unknown>;
    },
  ): Promise<T | undefined>;
  render?(session: HarnessSession, account?: string, notice?: string): void;
  /** The prompt this client has just submitted, or undefined for a synthetic
   * turn that shows none. Held until the turn ends: see
   * tui/render/pending-prompt.ts for why a snapshot cannot carry it. */
  submitted?(prompt: string | undefined): void;
  response?(text: string, mode?: 'append' | 'replace'): void;
  approval?(title: string, detail?: string, preview?: ApprovalPreview, rule?: string): Promise<boolean | 'always'>;
  activityEvent?(event: HarnessActivityEvent): void;
  panel?(title: string, body: string): void;
  close(): void;
}

export type MessageBlock =
  | { kind: 'paragraph'; text: string; quoteDepth: number; indent: number; sourceEnd: number; blockBoundary?: boolean }
  | { kind: 'heading'; text: string; level: number; quoteDepth: number; sourceEnd: number; blockBoundary?: boolean }
  | { kind: 'rule'; quoteDepth: number; sourceEnd: number; blockBoundary?: boolean }
  | { kind: 'code'; lines: string[]; language?: string; quoteDepth: number; indent: number; sourceEnd: number; blockBoundary?: boolean }
  | { kind: 'table'; header: string[]; rows: string[][]; align: Array<'left' | 'center' | 'right' | null>; quoteDepth: number; sourceEnd: number; blockBoundary?: boolean }
  | { kind: 'list-item'; text: string; depth: number; ordered: boolean; number?: number; task: boolean; checked?: boolean; quoteDepth: number; sourceEnd: number; blockBoundary?: boolean };

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
}
