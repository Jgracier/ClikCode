import { describe, expect, it } from 'vitest';
import { pickedAccount } from './manual-account';
import type { AiHarnessAccount } from '../harness/definition';

const account = (id: string, provider = 'anthropic'): AiHarnessAccount => ({ id, provider, label: id } as AiHarnessAccount);
const [a, b, c] = [account('a'), account('b'), account('c', 'openai')];
const base = { accounts: [a, b, c], canRun: (item: AiHarnessAccount) => item.provider === 'anthropic' };

describe('the account the user picked while a turn ran', () => {
  it('is a record that names an account the turn has neither read nor written', () => {
    expect(pickedAccount({ ...base, recorded: 'b', seen: 'a', current: a })).toBe(b);
  });

  it('is nothing while the record still names what the turn started on', () => {
    expect(pickedAccount({ ...base, recorded: 'a', seen: 'a', current: a })).toBeUndefined();
  });

  it('is not the turn\'s own failover, whose write the record has not caught up with', () => {
    // Failed over a -> b; the record still says a, as it did when the turn
    // last looked. Reading it as a pick would send the turn back to the
    // account it just left.
    expect(pickedAccount({ ...base, recorded: 'a', seen: 'a', current: b })).toBeUndefined();
    // Once the write lands the baseline moves, and a is a pick again.
    expect(pickedAccount({ ...base, recorded: 'a', seen: 'b', current: b })).toBe(a);
  });

  it('is nothing for an account this turn cannot run, or one that is gone', () => {
    expect(pickedAccount({ ...base, recorded: 'c', seen: 'a', current: a })).toBeUndefined();
    expect(pickedAccount({ ...base, recorded: 'z', seen: 'a', current: a })).toBeUndefined();
    expect(pickedAccount({ ...base, recorded: undefined, seen: 'a', current: a })).toBeUndefined();
  });
});
