import { describe, expect, it, vi } from 'vitest';

let pressKey: (key: string) => void = () => {};
vi.mock('./input-decoder.js', () => ({
  takeTerminalKeys: (onKey: (key: string) => void) => { pressKey = onKey; return () => {}; },
}));

const { nextInlineChoice, runOptionPicker } = await import('./option-picker.js');

const two = [{ value: 'auto' }, { value: 'never' }];
const three = [{ value: 'ask' }, { value: 'bypass' }, { value: 'auto' }];

describe('switching a setting in place', () => {
  it('flips between two', () => {
    expect(nextInlineChoice(two, 'auto').value).toBe('never');
    expect(nextInlineChoice(two, 'never').value).toBe('auto');
  });

  it('cycles through a few, wrapping', () => {
    expect(nextInlineChoice(three, 'ask').value).toBe('bypass');
    expect(nextInlineChoice(three, 'auto').value).toBe('ask');
  });

  it('moves a value that is no longer offered to the first choice', () => {
    expect(nextInlineChoice(three, 'xhigh').value).toBe('ask');
  });
});

describe('a row action that fails', () => {
  const host = {
    paint: () => {}, clearFrame: () => {}, setSelecting: () => {},
    // The delete confirmation, answered "yes".
    select: async () => true as never,
  };
  const row = { label: 'Work', value: 'acct', deleteAction: { label: 'Disconnect', value: 'disconnect' } };

  it('closes the list and reaches its caller instead of looking like nothing happened', async () => {
    const picked = runOptionPicker(host, 'Accounts', [row], async () => { throw new Error('copilot exited 1'); });
    pressKey('\u001b[3~');
    await expect(picked).rejects.toThrow('copilot exited 1');
  });

  it('closes the list when the action succeeds', async () => {
    const done: string[] = [];
    const picked = runOptionPicker(host, 'Accounts', [row], async (value, action) => { done.push(`${value}:${action}`); });
    pressKey('\u001b[3~');
    await expect(picked).resolves.toBeUndefined();
    expect(done).toEqual(['acct:disconnect']);
  });
});
