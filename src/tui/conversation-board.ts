/** The conversation board: every conversation on one full page, with a
 * composer under it.
 *
 * Opened with Left from an empty chat composer (or /resume). It follows the
 * shape of Claude Code's session list -- running work first, in sections --
 * and adds what that list does not have, a composer: with no conversation
 * selected, what is typed and sent starts a NEW conversation in the provider
 * and model shown below it, and a `/` line offers the commands that change
 * those first.
 *
 *   ↑↓      move between the composer and the list
 *   Enter   open the selected conversation, taking a draft with it; with
 *           none selected, a draft starts a new one
 *   →       open it (a working one shows its agents live inside)
 *   ←       close
 *   Tab/Del a conversation's options / delete it
 *   Esc     clear the draft, then close
 *   Ctrl+L  draw the whole screen again
 *
 * The decisions are `boardKey`, a pure function, so they are tested without a
 * terminal; `runConversationBoard` only wires it to one. */

import { stdout as output } from 'node:process';
import type { PickerOption } from '../harness/prompter.js';
import { takeTerminalKeys } from './input-decoder.js';
import { keyHintFor } from '../harness/protocol/wording.js';
import { reducedMotion } from './capabilities.js';
import { pickerDeletesSelection } from './command-palette.js';
import { asideOpener, confirmRowDelete, redrawOnRefresh, type OptionPickerHost } from './option-picker.js';
import { conversationLabel } from './pickers/conversation-activity.js';
import { SPIN_MS } from '../harness/protocol/timings.js';


/** `draft`: text typed on the board before a row was chosen, for the opened
 * conversation's composer -- never dropped. */
/** `addMachine`: a machine row chosen that is not added yet (`addable`). */
export type BoardResult = { open: string; draft?: string } | { compose: string } | { command: string } | { addMachine: string };

export interface BoardState {
  draft: string;
  /** A row of what is showing, or -1 for the composer. */
  selected: number;
  /** Ctrl+F. Typing filters the list instead of starting a conversation. */
  finding?: boolean;
  query?: string;
}

type BoardEffect =
  | { kind: 'draw' }
  | { kind: 'none' }
  | { kind: 'close' }
  /** Ctrl+L: the whole screen drawn again. */
  | { kind: 'repair' }
  | { kind: 'finish'; result: BoardResult }
  | { kind: 'actions' | 'delete'; option: PickerOption<string> };

/** A `/` draft shows the commands it matches in place of the conversations. */
function boardShowsCommands(state: BoardState): boolean {
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
  if (key === '\u000c') return { kind: 'repair' };
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
    // Right or Enter opens the selected conversation, taking a draft typed
    // here with it; Left always comes back out.
    const draft = state.draft.trim();
    if (key === RIGHT) return row ? { kind: 'finish', result: { open: row.value, ...(draft ? { draft } : {}) } } : { kind: 'none' };
    if (key === '\r' || key === '\n') {
      if (row) return { kind: 'finish', result: { open: row.value, ...(draft ? { draft } : {}) } };
      return draft ? { kind: 'finish', result: { compose: draft } } : { kind: 'none' };
    }
    if (key === LEFT) return row || !state.draft ? { kind: 'close' } : { kind: 'none' };
    if (key === '\t') return row?.actions?.length ? { kind: 'actions', option: row } : { kind: 'none' };
    if (pickerDeletesSelection(key, state.draft)) return row?.deleteAction ? { kind: 'delete', option: row } : { kind: 'none' };
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

/** Only the keys that act on what is selected, in a few words each. */
export function boardHint(state: BoardState, rows: readonly PickerOption<string>[], hasMachines = false): string {
  if (state.finding && !boardShowsCommands(state)) {
    const query = state.query ?? '';
    return `find${query ? `: ${query}` : ''} · ${rows.length ? keyHintFor('enter', 'open') : 'no match'} · ${keyHintFor('esc', 'clear')}`;
  }
  if (boardShowsCommands(state)) return `${rows.length ? keyHintFor('enter', 'run') : 'no command matches'} · ${keyHintFor('esc', 'clear')}`;
  const row = state.selected >= 0 ? rows[state.selected] : undefined;
  if (!row) {
    return state.draft ? `${keyHintFor('enter', 'start a new chat')} · ${keyHintFor('esc', 'clear')}`
      : `type to start a new chat · ${keyHintFor('ctrl+f', 'find')} · ${keyHintFor('↑↓', 'chats')}${hasMachines ? ` · ${keyHintFor('←', 'machines')}` : ''}`;
  }
  return [
    keyHintFor('enter', 'open'),
    ...(row.actions?.length ? [keyHintFor('tab', 'options')] : []),
    ...(row.deleteAction ? [keyHintFor('del', row.deleteAction.label.toLowerCase())] : []),
    keyHintFor('←', hasMachines ? 'machines' : 'close'),
  ].join(' · ');
}

export interface ConversationBoardSettings {
  /** Rebuilt on every draw, so rows that land later (vendor discovery) appear. */
  conversations: (machineId?: string) => readonly PickerOption<string>[];
  /** When present, Left from chats opens this machine list. */
  machines?: () => readonly PickerOption<string>[];
  initialMachine?: string;
  onMachineSelected?: (machineId: string) => void;
  /** A machine row that is one to add (from the tailnet), not chats to list:
   * choosing it closes the board with `{ addMachine }`. */
  addable?: (machineId: string) => boolean;
  commands: readonly PickerOption<string>[];
  refresh?: Promise<unknown> | readonly Promise<unknown>[];
  /** Registers the board's redraw, for the list to call when its rows
   * change (a turn starting or ending in any window). The board does not
   * tick to find out. */
  listChanged?: (redraw: () => void) => void;
  onAction?: (value: string, action: string) => Promise<void>;
  /** The row the cursor starts on: the conversation this window is in, so
   * Right or Enter goes straight back to it. Absent or not listed (a new,
   * empty chat is not) and it starts on the top row. */
  initial?: string;
  /** Running chats were on screen and now the list is idle. Return true when
   * this process is leaving (a newer build takes the terminal). False keeps
   * the board up, and a later quiet tick asks again. */
  onSessionsSettled?: () => boolean;
}

/** The board had running chats, and now it does not. A draft, a search, or a
 * second screen means someone is using the list, so this is not the moment
 * to leave. `pending` is a finish that already happened while the list was
 * busy, or before a new build was ready. */
export function boardSessionsSettled(input: {
  sawWorking: boolean; anyWorking: boolean; draft: string; finding: boolean; aside: boolean;
  pending?: boolean;
}): boolean {
  const quiet = !input.anyWorking && !input.draft && !input.finding && !input.aside;
  return quiet && (input.sawWorking || Boolean(input.pending));
}

/** Remember a finish that could not leave yet. New work clears it, so the
 * next chance is when that work finishes too. */
export function boardSettlePending(input: {
  sawWorking: boolean; anyWorking: boolean; pending: boolean;
}): boolean {
  if (input.anyWorking) return false;
  return input.pending || input.sawWorking;
}

/** Where the cursor starts: on `initial` when it is listed, else the top row,
 * else the composer (nothing listed at all). */
export function boardStartRow(rows: readonly PickerOption<string>[], initial?: string): number {
  const at = initial === undefined ? -1 : rows.findIndex((row) => row.value === initial);
  return at >= 0 ? at : rows.length ? 0 : -1;
}

/** A row whose turn is running: its spinner is what the board ticks for. */
const spins = (row: PickerOption<string>): boolean => row.activity === 'working';

/** Everything but the list: the rule and hint around it, and the composer
 * block beneath (usage rule, input, title rule, provider line, spacing). */
const BOARD_CHROME_ROWS = 6;

export function runConversationBoard(host: OptionPickerHost, settings: ConversationBoardSettings): Promise<BoardResult | undefined> {
  return new Promise((resolve) => {
    host.setSelecting(true);
    const state: BoardState = { draft: '', selected: -1 };
    let level: 'chats' | 'machines' = 'chats';
    let machine = settings.initialMachine ?? 'local';
    let machineSelected = 0;
    const chatSelections = new Map<string, number>();
    let finished = false;
    let stopInput: () => void = () => {};
    const rows = (): readonly PickerOption<string>[] => level === 'machines'
      ? settings.machines?.() ?? []
      : boardRows(state, settings.conversations(machine), settings.commands);
    let frame = 0;
    /** A second screen is up (sub-agents, options): the board is not drawn. */
    let aside = false;
    /** Last spin tick saw a generating row -- one more draw after the last
     * one finishes, otherwise the spinner stays on screen. */
    let wasWorking = false;
    /** A finish already seen, waiting until the list is idle and the new
     * build wants the window. */
    let pendingSettle = false;
    const settled = (anyWorking: boolean): boolean => {
      const ready = boardSessionsSettled({
        sawWorking: wasWorking, anyWorking, draft: state.draft, finding: Boolean(state.finding), aside: aside || level === 'machines',
        pending: pendingSettle,
      });
      pendingSettle = boardSettlePending({ sawWorking: wasWorking, anyWorking, pending: pendingSettle });
      wasWorking = anyWorking;
      if (!ready || !settings.onSessionsSettled?.()) return false;
      finished = true;
      stopSpin();
      stopInput();
      return true;
    };
    // The board ticks only while there is something to tick for: a running
    // row's spinner, or a finish still waiting to be acted on. No spinner at
    // all under reduced motion (the glyph is the same each frame), but the
    // same tick is what notices a running chat finish, so it runs regardless.
    // Idle, nothing is rebuilt or drawn until a key or the list changes.
    let spin: NodeJS.Timeout | undefined;
    const stopSpin = (): void => { clearInterval(spin); spin = undefined; };
    const tick = (): void => {
      if (finished || aside) return;
      const anyWorking = rows().some(spins);
      const hadWorking = wasWorking;
      if (settled(anyWorking)) return;
      // One more draw after the last running row finishes, or its spinner
      // stays on screen until a key is pressed.
      if (!anyWorking && !hadWorking) {
        if (!pendingSettle) stopSpin();
        return;
      }
      if (!reducedMotion()) frame += 1;
      draw();
    };
    state.selected = boardStartRow(rows(), settings.initial);
    /** The rows and draft the last frame showed, so a refresh that changed
     * nothing draws nothing. */
    let drawn: { rows: readonly PickerOption<string>[]; key: string } | undefined;
    const draw = (): void => {
      const showing = rows();
      drawn = { rows: showing, key: drawKey() };
      if (!spin && showing.some(spins)) {
        spin = setInterval(tick, SPIN_MS);
        spin.unref();
      }
      if (level === 'chats' && state.selected >= showing.length) state.selected = showing.length - 1;
      if (level === 'machines' && machineSelected >= showing.length) machineSelected = Math.max(0, showing.length - 1);
      // The whole page: the list takes every row the composer does not, at
      // whatever height the screen is when it is painted.
      // A titled machine list has one extra overlay row. Reserve its space
      // so the title does not disappear above the top of the screen.
      const capacity = (): number => Math.max(5, (output.rows ?? 24) - BOARD_CHROME_ROWS - (level === 'machines' ? 1 : 0));
      // Nothing to list yet: said, rather than a bare hint line.
      const empty = !showing.length && !boardShowsCommands(state) && !state.finding;
      host.paint(level === 'machines' ? '' : state.draft, empty ? [{ label: level === 'machines' ? 'No machines yet' : 'No conversations yet', value: '' }] : showing.map((row) => ({
        // Conversations get the glyph column, the spinner animated; commands do not.
        label: level === 'machines' || boardShowsCommands(state) ? row.label : conversationLabel(row, frame), detail: row.detail, value: '', group: row.group,
      })),
        level === 'machines' ? machineSelected : state.selected, '› ', level === 'machines' ? 0 : state.draft.length,
        { capacity, headings: true, title: level === 'machines' ? 'Machines' : undefined, hideChatTitle: true,
          hint: level === 'machines' ? '↑↓ choose · → chats · ← back' : boardHint(state, showing, Boolean(settings.machines)) });
    };
    const drawKey = (): string => `${level}\u0000${machine}\u0000${machineSelected}\u0000${state.draft}\u0000${state.selected}\u0000${state.finding ?? ''}\u0000${state.query ?? ''}\u0000${frame}\u0000${output.rows}`;
    /** A redraw for something outside the board: only if what it shows moved. */
    const redraw = (): void => {
      if (finished || aside) return;
      if (drawn && drawn.rows === rows() && drawn.key === drawKey()) return;
      draw();
    };
    const finish = (result: BoardResult | undefined): void => {
      if (finished) return;
      finished = true;
      stopSpin();
      host.setSelecting(false);
      stopInput();
      // The next paint is the conversation chosen (or the one left, on Esc), drawn with its
      // composer in one change; clearing the board first drew the conversation being left, bare.
      // Adding a machine is not that: its questions and steps are drawn on the chat.
      if (host.keepFrame && !(result && 'addMachine' in result)) host.keepFrame(); else host.clearFrame();
      resolve(result);
    };
    const listen = (): void => {
      stopInput = takeTerminalKeys((key) => { if (!finished) handle(key); });
      draw();
    };
    /** A second screen (sub-agents, options, a delete confirmation) has the
     * keyboard until it closes; then the board takes it back. */
    const openAside = asideOpener({
      stopInput: () => stopInput(), listen, finished: () => finished, aside: (open) => { aside = open; },
    });
    const handle = (key: string): void => {
      if (level === 'machines') {
        const available = rows();
        if (key === UP) machineSelected = Math.max(0, machineSelected - 1);
        else if (key === DOWN) machineSelected = Math.min(available.length - 1, machineSelected + 1);
        else if (key === RIGHT || key === '\r' || key === '\n') {
          const chosen = available[machineSelected];
          if (chosen && settings.addable?.(chosen.value)) {
            finish({ addMachine: chosen.value });
            return;
          }
          if (chosen) {
            machine = chosen.value;
            settings.onMachineSelected?.(machine);
            level = 'chats';
            state.selected = chatSelections.get(machine) ?? boardStartRow(settings.conversations(machine));
          }
        } else if (key === LEFT || key === '\u001b') {
          level = 'chats';
          state.selected = chatSelections.get(machine) ?? boardStartRow(settings.conversations(machine));
        } else if (key === '\u000c') host.repair?.();
        draw();
        return;
      }
      if (settings.machines && key === LEFT && !state.draft && !state.finding) {
        chatSelections.set(machine, state.selected);
        machineSelected = Math.max(0, settings.machines().findIndex((item) => item.value === machine));
        level = 'machines';
        draw();
        return;
      }
      const effect = boardKey(state, key, rows());
      if (effect.kind === 'draw') draw();
      else if (effect.kind === 'repair') { host.repair?.(); draw(); }
      else if (effect.kind === 'close') finish(undefined);
      else if (effect.kind === 'finish') finish(effect.result);
      else if (effect.kind === 'actions') {
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
          if (!await confirmRowDelete(host, option, action, option.detail?.replace(/^·\s*/, ''))) return false;
          await settings.onAction?.(option.value, action.value);
          finish(undefined);
          return true;
        });
      }
    };
    listen();
    redrawOnRefresh(settings.refresh, redraw);
    settings.listChanged?.(redraw);
  });
}
