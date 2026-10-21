/** When a turn opens a standby for the account a failover would move to: only on an account near
 * its limit, and only when there is another account to move to. */
import { describe, expect, it, vi } from 'vitest';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessState } from '../session/model.js';

vi.mock('../runtime/lazy-bridge.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../runtime/lazy-bridge.js')>(),
  isDirectModelProvider: () => false,
}));

const { nearUsageLimit, standbyAccountFor, STANDBY_AT_USED_PCT } = await import('./vendor-standby.js');

const now = Date.parse('2026-10-21T22:45:00.000Z');
const inAnHour = new Date(now + 3_600_000).toISOString();
const anHourAgo = new Date(now - 3_600_000).toISOString();

function account(id: string, windows: Array<{ name: string; usedPct: number; resetsAt?: string; advisory?: true }> = [], extra: Partial<AiHarnessAccount> = {}): AiHarnessAccount {
  return {
    id, provider: 'anthropic', label: id, authKind: 'vendor-cli', models: [], status: 'ready', credentialRef: `native:${id}`,
    usage: { at: new Date(now - 60_000).toISOString(), windows } as AiHarnessAccount['usage'], ...extra,
  };
}

function state(accounts: AiHarnessAccount[]): HarnessState {
  return {
    version: 1, installationId: 'test', localApiToken: 't', devicePrivateKeyPem: '', devicePublicKey: {},
    accounts, sessions: [], invocations: [], globalSettings: { effort: 'medium', permissionMode: 'ask' }, providerSettings: {},
  };
}

describe('a failover standby', () => {
  it('is not opened for an account below the threshold, even with another account to move to', () => {
    const current = account('a', [{ name: '5h', usedPct: 40, resetsAt: inAnHour }, { name: 'weekly', usedPct: STANDBY_AT_USED_PCT - 5, resetsAt: inAnHour }]);
    expect(nearUsageLimit(current, now)).toBe(false);
    expect(standbyAccountFor(state([current, account('b')]), current, now)).toBeUndefined();
  });

  it('is not opened for an account with no reading at all', () => {
    const current = account('a', [], { usage: undefined });
    expect(standbyAccountFor(state([current, account('b')]), current, now)).toBeUndefined();
  });

  it('is opened for the next account when the current one is at the threshold', () => {
    const current = account('a', [{ name: '5h', usedPct: STANDBY_AT_USED_PCT, resetsAt: inAnHour }]);
    expect(standbyAccountFor(state([current, account('b')]), current, now)?.id).toBe('b');
  });

  it('is opened for an account the vendor refused', () => {
    const current = account('a', [], {
      usage: undefined, quotaState: 'exhausted', quotaExhaustedAt: new Date(now - 60_000).toISOString(), quotaRetryAt: inAnHour,
    });
    expect(standbyAccountFor(state([current, account('b')]), current, now)?.id).toBe('b');
  });

  it('is not opened when there is no other account to move to', () => {
    const current = account('a', [{ name: '5h', usedPct: 97, resetsAt: inAnHour }]);
    expect(standbyAccountFor(state([current]), current, now)).toBeUndefined();
    // Another vendor's account, or a spent one, is not somewhere this turn can move.
    const other = account('c', [], { provider: 'openai' });
    const spent = account('d', [], { usage: { at: new Date(now).toISOString(), windows: [{ name: '5h', usedPct: 100, resetsAt: inAnHour }] } as AiHarnessAccount['usage'] });
    expect(standbyAccountFor(state([current, other, spent]), current, now)).toBeUndefined();
  });

  it('ignores a figure from a window that has since reset, and an advisory one', () => {
    const stale = account('a', [{ name: '5h', usedPct: 99, resetsAt: anHourAgo }]);
    const advisory = account('a', [{ name: 'api', usedPct: 99, advisory: true }]);
    expect(standbyAccountFor(state([stale, account('b')]), stale, now)).toBeUndefined();
    expect(standbyAccountFor(state([advisory, account('b')]), advisory, now)).toBeUndefined();
  });
});
