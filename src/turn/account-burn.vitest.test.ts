/** Moving off an account before it refuses, on a reading that can be believed and a margin measured
 * from the account's own burn (account-burn.ts), through the choice a turn starts with. */
import { describe, expect, it } from 'vitest';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessState } from '../session/model.js';
import { burnPerTurn } from './account-burn.js';
import { initialAccountChoice } from './account-routing.js';

const NOW = Date.parse('2026-10-30T12:00:00.000Z');
const HOUR = 3_600_000;
/** The weekly window of an account that resets in a day: it opened six days ago. */
const resetsAt = new Date(NOW + 24 * HOUR).toISOString();

const account = (id: string, usedPct: number, readAgeMs = 0, window = 'weekly'): AiHarnessAccount => ({
  id, provider: 'fake', label: id, status: 'ready', authKind: 'vendor-cli', models: [], credentialRef: 'native:fake',
  usage: { at: new Date(NOW - readAgeMs).toISOString(), windows: [{ name: window, usedPct, resetsAt }] },
} as AiHarnessAccount);

/** `turns` invocations of `id`, spread over the last five days of its window. */
const invocations = (id: string, turns: number): HarnessState['invocations'] =>
  Array.from({ length: turns }, (_, index) => ({ id: `${id}-${index}`, accountId: id, provider: 'fake', at: new Date(NOW - (index + 1) * HOUR).toISOString(), latencyMs: 1 }));

const choose = (current: AiHarnessAccount, others: AiHarnessAccount[], turns: HarnessState['invocations'], options: { turns?: number } = {}) =>
  initialAccountChoice({ accounts: [current, ...others], invocations: turns } as HarnessState, current, () => true, new Map(), { now: NOW, ...options });

describe('the measured burn of an account', () => {
  it('is the percent of its window used, per turn run on it since the window opened', () => {
    const a = account('a', 80);
    expect(burnPerTurn(a, a.usage!.windows![0]!, invocations('a', 40), NOW)).toBe(2);
    // Turns before the window opened are not its.
    const old = [{ ...invocations('a', 1)[0]!, at: new Date(NOW - 8 * 24 * HOUR).toISOString() }];
    expect(burnPerTurn(a, a.usage!.windows![0]!, old, NOW)).toBeUndefined();
    // Nothing used, nothing burnt; a window whose length the name does not give cannot be measured.
    expect(burnPerTurn(account('z', 0), account('z', 0).usage!.windows![0]!, [], NOW)).toBe(0);
    const odd = account('o', 50, 0, 'custom');
    expect(burnPerTurn(odd, odd.usage!.windows![0]!, invocations('o', 5), NOW)).toBeUndefined();
  });
});

describe('moving before the refusal', () => {
  // 99% of the week used over 40 turns: a turn costs about 2.5%, and 1% is left.
  const nearlyOut = (readAgeMs = 0) => account('a', 99, readAgeMs);
  const burn = invocations('a', 40);

  it('moves when the room left is less than a turn costs and another account has more by that margin', () => {
    expect(choose(nearlyOut(), [account('b', 10)], burn)).toMatchObject({ kind: 'switch', reason: 'low-room', account: { id: 'b' } });
  });

  it('does not move on the same reading three hours old: readings lag', () => {
    expect(choose(nearlyOut(3 * HOUR), [account('b', 10)], burn)).toEqual({ kind: 'continue' });
  });

  it('does not move onto an account whose own reading is not current', () => {
    expect(choose(nearlyOut(), [account('b', 10, 3 * HOUR)], burn)).toEqual({ kind: 'continue' });
  });

  it('does not move to an account with less room, or without clearly more', () => {
    expect(choose(nearlyOut(), [account('b', 99.5)], [...burn, ...invocations('b', 40)])).toEqual({ kind: 'continue' });
    // 1% left here, 2% there: more, but not by what a turn costs.
    expect(choose(nearlyOut(), [account('b', 98)], [...burn, ...invocations('b', 40)])).toEqual({ kind: 'continue' });
  });

  it('does not move while the room covers what a turn costs', () => {
    // 99% over 990 turns: a turn costs 0.1%, and 1% is left.
    expect(choose(nearlyOut(), [account('b', 10)], invocations('a', 990))).toEqual({ kind: 'continue' });
  });

  it('weighs the agents about to run beside the turn', () => {
    // 20% left, 99 turns at 0.8% each: one turn fits, four do not.
    const current = account('a', 80);
    const turns = invocations('a', 100);
    expect(choose(current, [account('b', 10)], turns)).toEqual({ kind: 'continue' });
    expect(choose(current, [account('b', 10)], turns, { turns: 30 })).toMatchObject({ kind: 'switch', reason: 'low-room' });
  });

  it('has nothing to go by when no turn of ours is in the window', () => {
    expect(choose(nearlyOut(), [account('b', 10)], [])).toEqual({ kind: 'continue' });
  });

  it('does not move on a window that has reset since it was read', () => {
    const current = nearlyOut();
    current.usage!.windows![0]!.resetsAt = new Date(NOW - HOUR).toISOString();
    expect(choose(current, [account('b', 10)], burn)).toEqual({ kind: 'continue' });
  });

  it('still moves off a refused account, as before', () => {
    const refused = { ...account('a', 10, HOUR), quotaState: 'exhausted', quotaExhaustedAt: new Date(NOW - 1_000).toISOString(), quotaRetryAt: new Date(NOW + HOUR).toISOString() } as AiHarnessAccount;
    expect(choose(refused, [account('b', 10)], [])).toMatchObject({ kind: 'switch', reason: 'quota-exhausted', account: { id: 'b' } });
  });
});
