import { describe, expect, it, vi } from 'vitest';
import type { AiHarnessAccount } from '../harness/definition.js';

const lifecycle = vi.hoisted(() => vi.fn());
vi.mock('../runtime/lifecycle-log.js', () => ({ lifecycle, quiet: () => () => undefined, swallowed: () => undefined }));

import { switchAccountAfterFailure } from './account-switch.js';

const account = (id: string): AiHarnessAccount => ({ id, label: id } as AiHarnessAccount);

describe('switchAccountAfterFailure', () => {
  it('chooses, carries, records and says the switch, in that order', async () => {
    const calls: string[] = [];
    const accounts = {
      after: vi.fn(async () => { calls.push('after'); return account('bbbbbbbbbbbb'); }),
      switchTo: vi.fn(async () => { calls.push('switchTo'); }),
    };
    const result = await switchAccountAfterFailure({
      accounts, from: account('aaaaaaaaaaaa'), failure: new Error('x'), kind: 'quota-exhausted', harness: 'claude',
      carry: async () => { calls.push('carry'); return { value: 7, fields: { closeMs: 0, carryMs: 0, carried: 'standby' } }; },
    });
    expect(calls).toEqual(['after', 'carry', 'switchTo']);
    expect(result).toMatchObject({ kind: 'quota-exhausted', value: 7 });
    expect(result.to.id).toBe('bbbbbbbbbbbb');
    expect(accounts.switchTo).toHaveBeenCalledWith(result.to, 'quota-exhausted');
    expect(lifecycle).toHaveBeenCalledWith('worker.switch', expect.objectContaining({
      harness: 'claude', from: 'aaaaaaaa', to: 'bbbbbbbb', why: 'quota-exhausted', carried: 'standby',
    }));
  });

  it('classifies the failure itself when the caller did not', async () => {
    const accounts = { after: vi.fn(async () => account('b')), switchTo: vi.fn(async () => undefined) };
    const { kind } = await switchAccountAfterFailure({ accounts, from: account('a'), failure: new Error('Rate limit reached: 429'), harness: 'direct' });
    expect(accounts.after.mock.calls[0]![1]).toBe(kind);
  });

  it('ends the turn, switching nothing, when no account can take it', async () => {
    const accounts = { after: vi.fn(async () => { throw new Error('All accounts exhausted'); }), switchTo: vi.fn() };
    await expect(switchAccountAfterFailure({ accounts, from: account('a'), failure: new Error('x'), kind: 'quota-exhausted', harness: 'direct' })).rejects.toThrow('All accounts exhausted');
    expect(accounts.switchTo).not.toHaveBeenCalled();
  });
});
