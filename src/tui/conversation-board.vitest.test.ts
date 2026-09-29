import { describe, expect, it } from 'vitest';
import type { PickerOption } from '../harness/prompter';
import { boardKey, boardRows, type BoardState } from './conversation-board';

const UP = '\u001b[A';
const DOWN = '\u001b[B';
const RIGHT = '\u001b[C';
const LEFT = '\u001b[D';

const subagent: PickerOption<string> = { label: 'Agent(Explore)', value: 'busy' };
const conversations: PickerOption<string>[] = [
  { label: 'Busy', value: 'busy', inner: { title: 'Subagents', options: [subagent] }, actions: [{ label: 'Rename', value: 'rename' }] },
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

  it('takes typing away from a selected row into a new draft', () => {
    const state = fresh();
    press(state, DOWN, 'h');
    expect(state).toEqual({ draft: 'h', selected: -1 });
  });

  it('opens a working conversation’s sub-agents with Left, and closes on one without', () => {
    const state = fresh();
    expect(press(state, DOWN, LEFT)).toEqual({ kind: 'inner', option: conversations[0] });
    expect(press(state, DOWN, LEFT)).toEqual({ kind: 'close' });
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
});
