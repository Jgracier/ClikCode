import { describe, expect, it, vi } from 'vitest';
import { turnAccounts } from './account-routing.js';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessSession, HarnessState } from '../session/model.js';

vi.mock('../session/state/read.js', () => ({ readState: async () => ({ sessions: [], accounts: [] }) }));

describe('account switch recording', () => {
  it('saves the new account and the switch notice in one state write', async () => {
    const first = { id: 'first', provider: 'anthropic', label: 'First' } as AiHarnessAccount;
    const second = { id: 'second', provider: 'anthropic', label: 'Second' } as AiHarnessAccount;
    const session = { id: 'chat', accountId: first.id, pendingTurn: {} } as HarnessSession;
    let current = first;
    const persist = vi.fn(async () => undefined);
    const accounts = turnAccounts({ state: { accounts: [first, second] } as HarnessState, session,
      matchesBackend: () => true, persist, current: () => current, adopt: (account) => { current = account; } });

    await accounts.switchTo(second, 'quota-exhausted');

    expect(persist).toHaveBeenCalledTimes(1);
    expect(session.accountId).toBe(second.id);
    expect(session.pendingTurn?.accountSwitch).toMatchObject({ from: 'First', to: 'Second' });
  });
});
