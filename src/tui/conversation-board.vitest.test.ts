import { describe, expect, it } from 'vitest';
import type { PickerOption } from '../harness/prompter';
import { boardHint, boardKey, boardRows, boardSessionsSettled, boardSettlePending, boardStartRow, type BoardState } from './conversation-board';

const UP = '\u001b[A';
const DOWN = '\u001b[B';
const RIGHT = '\u001b[C';
const LEFT = '\u001b[D';

const subagent: PickerOption<string> = { label: 'Agent(Explore)', value: 'busy' };
const conversations: PickerOption<string>[] = [
  { label: 'Busy', value: 'busy', inner: { title: 'Agents', options: [subagent] }, actions: [{ label: 'Rename', value: 'rename' }] },
  { label: 'Old', value: 'old', deleteAction: { label: 'Delete', value: 'delete' } },
];
const commands: PickerOption<string>[] = [
  { label: '/provider', value: '/provider' },
  { label: '/model', value: '/model' },
];
const fresh = (): BoardState => ({ draft: '', selected: -1 });
const press = (state: BoardState, ...keys: string[]) => keys.map((key) => boardKey(state, key, boardRows(state, conversations, commands))).at(-1);

describe('the conversation board', () => {
  it('opens on the composer, and an arrow goes into the list at its top', () => {
    const state = fresh();
    press(state, DOWN);
    expect(state.selected).toBe(0);
    press(state, UP);
    expect(state.selected).toBe(-1);
  });

  it('starts a new conversation from a typed draft when nothing is selected', () => {
    const state = fresh();
    press(state, 'f', 'i', 'x', ' ', 'it');
    expect(press(state, '\r')).toEqual({ kind: 'finish', result: { compose: 'fix it' } });
  });

  it('sends nothing for an empty draft', () => {
    expect(press(fresh(), '\r')).toEqual({ kind: 'none' });
  });

  it('opens the selected conversation with Right or Enter', () => {
    const state = fresh();
    press(state, DOWN, DOWN);
    expect(press(state, RIGHT)).toEqual({ kind: 'finish', result: { open: 'old' } });
    expect(press(state, '\r')).toEqual({ kind: 'finish', result: { open: 'old' } });
  });

  it('filters the list with Ctrl+F, and Enter opens the match', () => {
    const state = fresh();
    expect(press(state, '\u0006')).toEqual({ kind: 'draw' });
    press(state, 'o', 'l');
    expect(boardRows(state, conversations, commands).map((row) => row.value)).toEqual(['old']);
    expect(press(state, '\r')).toEqual({ kind: 'finish', result: { open: 'old' } });
  });

  it('takes typing away from a selected row into a new draft', () => {
    const state = fresh();
    press(state, DOWN, 'h');
    expect(state).toEqual({ draft: 'h', selected: -1 });
  });

  it('goes into a working conversation’s agents with Right; Enter still opens it, and Left closes', () => {
    const state = fresh();
    expect(press(state, DOWN, RIGHT)).toEqual({ kind: 'inner', option: conversations[0] });
    expect(press(state, '\r')).toEqual({ kind: 'finish', result: { open: 'busy' } });
    expect(press(state, LEFT)).toEqual({ kind: 'close' });
  });

  it('closes with Left from an empty composer but not from a draft', () => {
    expect(press(fresh(), LEFT)).toEqual({ kind: 'close' });
    const drafting = fresh();
    expect(press(drafting, 'a', LEFT)).toEqual({ kind: 'none' });
  });

  it('shows the matching commands for a slash draft and picks one', () => {
    const state = fresh();
    press(state, '/', 'm');
    expect(boardRows(state, conversations, commands).map((row) => row.value)).toEqual(['/model']);
    expect(press(state, '\r')).toEqual({ kind: 'finish', result: { command: '/model' } });
  });

  it('clears a draft with Esc before it closes the board', () => {
    const state = fresh();
    press(state, 'a');
    expect(press(state, '\u001b')).toEqual({ kind: 'draw' });
    expect(state.draft).toBe('');
    expect(press(state, '\u001b')).toEqual({ kind: 'close' });
  });

  it('offers a row’s options and delete only where the row has them', () => {
    const state = fresh();
    expect(press(state, DOWN, '\t')).toEqual({ kind: 'actions', option: conversations[0] });
    expect(press(state, '\u001b[3~')).toEqual({ kind: 'none' });
    expect(press(state, DOWN, '\u001b[3~')).toEqual({ kind: 'delete', option: conversations[1] });
  });

  it('deletes on Backspace with no draft, since Mac and iPhone keyboards have no forward Delete', () => {
    const state = fresh();
    expect(press(state, DOWN, DOWN, '\u007f')).toEqual({ kind: 'delete', option: conversations[1] });
  });
});

describe('the board\'s footer', () => {
  const hint = (state: BoardState): string => boardHint(state, boardRows(state, conversations, commands));

  it('names only the keys that act on the selected row', () => {
    expect(hint({ draft: '', selected: 0 })).toBe('enter open · → agents · tab options · ← close');
    expect(hint({ draft: '', selected: 1 })).toBe('enter open · del delete · ← close');
  });

  it('on the composer, says how to start, find and reach the chats', () => {
    expect(hint(fresh())).toBe('type to start a new chat · ctrl+f find · ↑↓ chats');
    expect(hint({ draft: 'fix it', selected: -1 })).toBe('enter start a new chat · esc clear');
  });

  it('keeps find and command mode as terse', () => {
    expect(hint({ draft: '', selected: 0, finding: true, query: 'ol' })).toBe('find: ol · enter open · esc clear');
    expect(hint({ draft: '', selected: -1, finding: true, query: 'zz' })).toBe('find: zz · no match · esc clear');
    expect(hint({ draft: '/m', selected: 0 })).toBe('enter run · esc clear');
    expect(hint({ draft: '/zz', selected: 0 })).toBe('no command matches · esc clear');
  });
});

describe('where the board opens', () => {
  it('on the conversation this window is in, wherever it is listed', () => {
    expect(boardStartRow(conversations, 'old')).toBe(1);
  });

  it('on the top row from a new chat, which is not listed', () => {
    expect(boardStartRow(conversations, 'brand-new')).toBe(0);
    expect(boardStartRow(conversations)).toBe(0);
  });

  it('on the composer when there is nothing to list', () => {
    expect(boardStartRow([], 'anything')).toBe(-1);
  });

  it('goes straight back to the conversation it opened on', () => {
    const state: BoardState = { draft: '', selected: boardStartRow(conversations, 'old') };
    expect(boardKey(state, '\r', conversations)).toEqual({ kind: 'finish', result: { open: 'old' } });
  });
});

const quiet = { draft: '', finding: false, aside: false };

describe('when the board can hand the terminal to a new build', () => {
  it('does not leave a board that opened with nothing running', () => {
    expect(boardSessionsSettled({ sawWorking: false, anyWorking: false, ...quiet })).toBe(false);
    expect(boardSettlePending({ sawWorking: false, anyWorking: false, pending: false })).toBe(false);
  });

  it('waits while a chat is still running', () => {
    expect(boardSessionsSettled({ sawWorking: true, anyWorking: true, ...quiet })).toBe(false);
    expect(boardSettlePending({ sawWorking: true, anyWorking: true, pending: false })).toBe(false);
  });

  it('leaves when the running chats finish and the list is idle', () => {
    expect(boardSessionsSettled({ sawWorking: true, anyWorking: false, ...quiet })).toBe(true);
    expect(boardSettlePending({ sawWorking: true, anyWorking: false, pending: false })).toBe(true);
  });

  it('holds the finish while a draft, search, or aside is up, then leaves', () => {
    expect(boardSessionsSettled({ sawWorking: true, anyWorking: false, ...quiet, draft: 'fix' })).toBe(false);
    expect(boardSessionsSettled({ sawWorking: true, anyWorking: false, ...quiet, finding: true })).toBe(false);
    expect(boardSessionsSettled({ sawWorking: true, anyWorking: false, ...quiet, aside: true })).toBe(false);
    const pending = boardSettlePending({ sawWorking: true, anyWorking: false, pending: false });
    expect(boardSessionsSettled({ sawWorking: false, anyWorking: false, ...quiet, pending })).toBe(true);
  });

  it('asks again after a finish if the new build was not ready yet', () => {
    const pending = boardSettlePending({ sawWorking: true, anyWorking: false, pending: false });
    expect(boardSessionsSettled({ sawWorking: false, anyWorking: false, ...quiet, pending })).toBe(true);
  });

  it('waits for new work that starts after a finish', () => {
    expect(boardSettlePending({ sawWorking: false, anyWorking: true, pending: true })).toBe(false);
    expect(boardSessionsSettled({ sawWorking: false, anyWorking: true, ...quiet, pending: true })).toBe(false);
  });
});
