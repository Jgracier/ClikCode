/** The conversation board: every conversation on one full page, with a
 * composer under it.
 *
 * Opened with Left from an empty chat composer (or /resume). It follows the
 * shape of Claude Code's session list -- running work first, sections with
 * their size -- and adds what that list does not have, a composer: with no
 * conversation selected, what is typed and sent starts a NEW conversation in
 * the provider and model shown below it, and a `/` line offers the commands
 * that change those first.
 *
 *   ↑↓      move between the composer and the list
 *   → Enter open the selected conversation (Enter with a draft: start one)
 *   ←       a working conversation's sub-agents; otherwise close
 *   Tab/Del a conversation's options / delete it
 *   Esc     clear the draft, then close
 *
 * The decisions are `boardKey`, a pure function, so they are tested without a
 * terminal; `runConversationBoard` only wires it to one. */

import { stdout as output } from 'node:process';
import type { PickerOption } from '../harness/prompter.js';
import { takeTerminalKeys } from './input-decoder.js';
import { reducedMotion } from './capabilities.js';
import { pickerDeletesSelection } from './command-palette.js';
import type { OptionPickerHost } from './option-picker.js';
import { workingSpinner } from './pickers/conversation-activity.js';

/** How often a running conversation's spinner moves. Only its cells change
 * between frames, so this costs a few bytes each, even over SSH. */
const SPIN_MS = 160;

export type BoardResult = { open: string } | { compose: string } | { command: string };

export interface BoardState {
  draft: string;
  /** A row of what is showing, or -1 for the composer. */
  selected: number;
  /** Ctrl+F. Typing filters the list instead of starting a conversation. */
  finding?: boolean;
  query?: string;
}

export type BoardEffect =
  | { kind: 'draw' }
  | { kind: 'none' }
  | { kind: 'close' }
  | { kind: 'finish'; result: BoardResult }
  | { kind: 'inner' | 'actions' | 'delete'; option: PickerOption<string> };

/** A `/` draft shows the commands it matches in place of the conversations. */
export function boardShowsCommands(state: BoardState): boolean {
  return state.draft.startsWith('/');
}

export function boardRows(
  state: BoardState, conversations: readonly PickerOption<string>[], commands: readonly PickerOption<string>[],
): readonly PickerOption<string>[] {
  if (boardShowsCommands(state)) {
    const typed = state.draft.trim().toLowerCase();
    return commands.filter((command) => command.value.toLowerCase().startsWith(typed));
  }
  const query = state.finding ? (state.query ?? '').trim().toLowerCase() : '';
  if (!query) return conversations;
  return conversations.filter((row) => `${row.label} ${row.detail ?? ''}`.toLowerCase().includes(query));
}

const UP = '\u001b[A';
const DOWN = '\u001b[B';
const RIGHT = '\u001b[C';
const LEFT = '\u001b[D';

/** What one key does to the board. Mutates `state`; says what else to do. */
const FIND = '\u0006';

export function boardKey(state: BoardState, key: string, rows: readonly PickerOption<string>[]): BoardEffect {
  const commandMode = boardShowsCommands(state);
  const row = state.selected >= 0 ? rows[state.selected] : undefined;
  if (key === '\u0003') return { kind: 'close' };
  if (key === FIND && !commandMode) {
    state.finding = !state.finding;
    state.query = '';
    if (state.finding) state.selected = rows.length ? 0 : -1;
    return { kind: 'draw' };
  }
  if (state.finding && !commandMode) {
    if (key === '\u001b') {
      state.finding = false;
      state.query = '';
      return { kind: 'draw' };
    }
    if (key === UP) { state.selected = Math.max(0, state.selected - 1); return { kind: 'draw' }; }
    if (key === DOWN) { state.selected = Math.min(Math.max(rows.length - 1, 0), state.selected + 1); return { kind: 'draw' }; }
    if (key === '\r' || key === '\n' || key === RIGHT) return row ? { kind: 'finish', result: { open: row.value } } : { kind: 'none' };
    if (key === '\u007f' || key === '\b') {
      state.query = (state.query ?? '').slice(0, -1);
      state.selected = 0;
      return { kind: 'draw' };
    }
    if (!key.startsWith('\u001b') && [...key].every((character) => character >= ' ' )) {
      state.query = `${state.query ?? ''}${key}`;
      state.selected = 0;
      return { kind: 'draw' };
    }
    return { kind: 'none' };
  }
  if (key === '\u001b') {
    if (!state.draft) return { kind: 'close' };
    state.draft = '';
    state.selected = -1;
    return { kind: 'draw' };
  }
  if (commandMode) {
    if (key === UP) { state.selected = Math.max(0, state.selected - 1); return { kind: 'draw' }; }
    if (key === DOWN) { state.selected = Math.min(rows.length - 1, state.selected + 1); return { kind: 'draw' }; }
    if (key === '\r' || key === '\n' || key === RIGHT || key === '\t') {
      return row ? { kind: 'finish', result: { command: row.value } } : { kind: 'none' };
    }
  } else {
    // From the composer, either arrow goes into the list at its top: the top
    // is what is running, which is what this board is for.
    if (key === UP) { state.selected = Math.max(-1, state.selected - 1); return { kind: 'draw' }; }
    if (key === DOWN) {
      if (rows.length) state.selected = Math.min(rows.length - 1, state.selected + 1);
      return { kind: 'draw' };
    }
    if (key === RIGHT) return row ? { kind: 'finish', result: { open: row.value } } : { kind: 'none' };
    if (key === '\r' || key === '\n') {
      if (row) return { kind: 'finish', result: { open: row.value } };
      const text = state.draft.trim();
      return text ? { kind: 'finish', result: { compose: text } } : { kind: 'none' };
    }
    if (key === LEFT) {
      if (row?.inner?.options.length) return { kind: 'inner', option: row };
      if (row || !state.draft) return { kind: 'close' };
      return { kind: 'none' };
    }
    if (key === '\t') return row?.actions?.length ? { kind: 'actions', option: row } : { kind: 'none' };
    if (pickerDeletesSelection(key)) return row?.deleteAction ? { kind: 'delete', option: row } : { kind: 'none' };
  }
  if (key === '\u007f' || key === '\b') {
    if (!state.draft) return { kind: 'none' };
    state.draft = state.draft.slice(0, -1);
    state.selected = boardShowsCommands(state) ? 0 : -1;
    return { kind: 'draw' };
  }
  // Typing -- one key or a paste -- always goes to the composer, whatever was
  // selected: a draft is a new conversation, never an edit to a row.
  if (!key.startsWith('\u001b') && [...key].every((character) => character >= ' ' || character === '\n')) {
    state.draft += key.replace(/[\r\n]+/g, ' ');
    state.selected = boardShowsCommands(state) ? 0 : -1;
    return { kind: 'draw' };
  }
  return { kind: 'none' };
}

export function boardHint(state: BoardState, rows: readonly PickerOption<string>[]): string {
  if (state.finding && !boardShowsCommands(state)) {
    const query = state.query ?? '';
    return rows.length
      ? `find${query ? `: ${query}` : ''} · ↑↓ choose · Enter open · Esc clear`
      : `find${query ? `: ${query}` : ''} · no conversation matches · Esc clear`;
  }
  if (boardShowsCommands(state)) return rows.length ? '↑↓ choose · Enter open · Esc clear' : 'no command matches · Esc clear';
  const row = state.selected >= 0 ? rows[state.selected] : undefined;
  if (!row) {
    return state.draft
      ? 'Enter start a new conversation · Esc clear'
      : 'type to start a new conversation · Ctrl+F find · / provider and model · ↑↓ conversations · ← close';
  }
  const back = row.inner?.options.length ? `← ${row.inner.title.toLowerCase()}` : '← close';
  const tab = row.actions?.length ? ' · Tab options' : '';
  const del = row.deleteAction ? ` · Del ${row.deleteAction.label.toLowerCase()}` : '';
  return `→/Enter open · ${back}${tab}${del} · ↑↓ move · type to start new`;
}

export interface ConversationBoardSettings {
  /** Rebuilt on every draw, so rows that land later (vendor discovery) appear. */
  conversations: () => readonly PickerOption<string>[];
  commands: readonly PickerOption<string>[];
  refresh?: Promise<unknown> | readonly Promise<unknown>[];
  onAction?: (value: string, action: string) => Promise<void>;
  /** The row the cursor starts on: the conversation this window is in, so
   * Right or Enter goes straight back to it. Absent or not listed (a new,
   * empty chat is not) and it starts on the top row. */
  initial?: string;
}

/** Where the cursor starts: on `initial` when it is listed, else the top row,
 * else the composer (nothing listed at all). */
export function boardStartRow(rows: readonly PickerOption<string>[], initial?: string): number {
  const at = initial === undefined ? -1 : rows.findIndex((row) => row.value === initial);
  return at >= 0 ? at : rows.length ? 0 : -1;
}

/** Everything but the list: the rule and hint around it, and the composer
 * block beneath (usage rule, input, title rule, provider line, spacing). */
const BOARD_CHROME_ROWS = 5;

export function runConversationBoard(host: OptionPickerHost, settings: ConversationBoardSettings): Promise<BoardResult | undefined> {
  return new Promise((resolve) => {
    host.setSelecting(true);
    const state: BoardState = { draft: '', selected: -1 };
    let finished = false;
    let stopInput: () => void = () => {};
    const rows = (): readonly PickerOption<string>[] => boardRows(state, settings.conversations(), settings.commands);
    let frame = 0;
    /** A second screen is up (sub-agents, options): the board is not drawn. */
    let aside = false;
    // No spinner at all under reduced motion: the glyph is the same each frame.
    const spin = reducedMotion() ? undefined : setInterval(() => {
      if (finished || aside || !rows().some((row) => row.working)) return;
      frame += 1;
      draw();
    }, SPIN_MS);
    spin?.unref();
    state.selected = boardStartRow(rows(), settings.initial);
    const draw = (): void => {
      const showing = rows();
      if (state.selected >= showing.length) state.selected = showing.length - 1;
      // The whole page: the list takes every row the composer does not.
      const capacity = Math.max(6, (output.rows ?? 24) - BOARD_CHROME_ROWS);
      host.paint(state.draft, showing.map((row) => ({
        label: row.working ? `${workingSpinner(frame, row.working)} ${row.label}` : row.label, detail: row.detail, value: '', group: row.group,
      })),
        state.selected, '› ', state.draft.length, { capacity, headings: true, hint: boardHint(state, showing) });
    };
    const finish = (result: BoardResult | undefined): void => {
      if (finished) return;
      finished = true;
      clearInterval(spin);
      host.setSelecting(false);
      stopInput();
      host.clearFrame();
      resolve(result);
    };
    const listen = (): void => {
      stopInput = takeTerminalKeys((key) => { if (!finished) handle(key); });
      draw();
    };
    /** A second screen (sub-agents, options, a delete confirmation) has the
     * keyboard until it closes; then the board takes it back. */
    const openAside = async (open: () => Promise<boolean>): Promise<void> => {
      stopInput();
      aside = true;
      try {
        if (await open()) return;
      } finally {
        aside = false;
      }
      if (!finished) listen();
    };
    const handle = (key: string): void => {
      const effect = boardKey(state, key, rows());
      if (effect.kind === 'draw') draw();
      else if (effect.kind === 'close') finish(undefined);
      else if (effect.kind === 'finish') finish(effect.result);
      else if (effect.kind === 'inner') {
        const inner = effect.option.inner!;
        void openAside(async () => {
          const value = await host.select(inner.title, inner.options);
          if (value === undefined) return false;
          finish({ open: value });
          return true;
        });
      } else if (effect.kind === 'actions') {
        const option = effect.option;
        void openAside(async () => {
          const action = await host.select(option.label, (option.actions ?? []).map((item) => ({ label: item.label, value: item.value })));
          if (!action) return false;
          await settings.onAction?.(option.value, action);
          // The caller rebuilds from state and reopens: the row may be gone.
          finish(undefined);
          return true;
        });
      } else if (effect.kind === 'delete') {
        const option = effect.option;
        const action = option.deleteAction!;
        void openAside(async () => {
          const confirmed = await host.select(`${action.label} ${option.label}?`, [
            { label: 'Cancel', value: false }, { label: `${action.label} ${option.label}`, value: true },
          ]);
          if (!confirmed) return false;
          await settings.onAction?.(option.value, action.value);
          finish(undefined);
          return true;
        });
      }
    };
    listen();
    for (const refresh of [settings.refresh ?? []].flat()) void refresh.then(() => { if (!finished) draw(); }, () => { if (!finished) draw(); });
  });
}
