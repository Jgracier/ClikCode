import { describe, expect, it } from 'vitest';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessState } from '../session/model.js';
import { noteStoredQuota } from './account-switch.js';
import { nextUsableFailoverAccount } from './runtime.js';

function account(id: string, extra: Partial<AiHarnessAccount> = {}): AiHarnessAccount {
  return {
    id, provider: 'anthropic', label: id, authKind: 'vendor-cli', models: [], status: 'ready',
    credentialRef: `native:${id}`, ...extra,
  };
}

function state(accounts: AiHarnessAccount[], invocations: HarnessState['invocations'] = []): HarnessState {
  return {
    version: 1, installationId: 'test', localApiToken: 't', devicePrivateKeyPem: '', devicePublicKey: {},
    accounts, sessions: [], invocations, globalSettings: { effort: 'medium', permissionMode: 'ask', accountFailover: 'on-quota-exhausted' },
    providerSettings: {},
  };
}

const later = new Date(Date.now() + 86_400_000).toISOString();
const earlier = new Date(Date.now() - 86_400_000).toISOString();

describe('stored-usage account switch', () => {
  it('picks the account with room left and skips one already refused, even when its saved percent still looks open', () => {
    const empty = account('empty', {
      quotaState: 'exhausted',
      usage: { at: new Date().toISOString(), label: 'weekly 40% left', windows: [{ name: 'weekly', usedPct: 60, resetsAt: later }] } as AiHarnessAccount['usage'],
    });
    const full = account('full', {
      usage: { at: new Date().toISOString(), label: 'weekly 80% left', windows: [{ name: 'weekly', usedPct: 20, resetsAt: later }] } as AiHarnessAccount['usage'],
    });
    const current = account('current', { quotaState: 'exhausted' });
    const picked = nextUsableFailoverAccount(state([current, empty, full]), current, () => true, new Set());
    expect(picked?.id).toBe('full');
    expect(empty.quotaState).toBe('exhausted');
  });

  it('does not start on an account whose saved window is already spent', () => {
    const spent = account('spent', {
      usage: { at: new Date().toISOString(), label: 'weekly 0% left', windows: [{ name: 'weekly', usedPct: 100, resetsAt: later }] } as AiHarnessAccount['usage'],
    });
    expect(noteStoredQuota(spent, state([spent]))).toBe(0);
    expect(spent.quotaState).toBe('exhausted');
  });

  it('tries an account with no displayed usage, behind one that shows room', () => {
    const unknown = account('unknown');
    const room = account('room', {
      usage: { at: new Date().toISOString(), label: 'weekly 10% left', windows: [{ name: 'weekly', usedPct: 90, resetsAt: later }] } as AiHarnessAccount['usage'],
    });
    const current = account('current', { quotaState: 'exhausted' });
    expect(nextUsableFailoverAccount(state([current, unknown, room]), current, () => true, new Set())?.id).toBe('room');
    expect(nextUsableFailoverAccount(state([current, unknown]), current, () => true, new Set())?.id).toBe('unknown');
  });

  it('ignores a positive percent that has no window, so it cannot outrank a real reading or clear a refusal', () => {
    const stale = account('stale', {
      quotaState: 'exhausted',
      usage: { at: new Date().toISOString(), label: 'weekly 40% left' },
    });
    const room = account('room', {
      usage: { at: new Date().toISOString(), label: 'weekly 5% left', windows: [{ name: 'weekly', usedPct: 95, resetsAt: later }] } as AiHarnessAccount['usage'],
    });
    const current = account('current');
    expect(nextUsableFailoverAccount(state([current, stale, room]), current, () => true, new Set())?.id).toBe('room');
    expect(stale.quotaState).toBe('exhausted');
  });

  it('lets a refused account back in once every spent window has reset', () => {
    const returned = account('returned', {
      quotaState: 'exhausted',
      usage: { at: earlier, label: 'weekly 0% left', windows: [{ name: 'weekly', usedPct: 100, resetsAt: earlier }] } as AiHarnessAccount['usage'],
    });
    expect(noteStoredQuota(returned, state([returned]))).toBeUndefined();
    expect(returned.quotaState).toBe('available');
  });

  it('skips a harness with no live probe once its learned usage says nothing is left', () => {
    const now = Date.now();
    const hour = 3_600_000;
    const id = 'learned';
    const spent = account(id, {
      provider: 'no-such-provider',
      usageLearning: {
        highWater: { '5h': 1000 },
        hits: [
          { at: new Date(now - 2 * hour).toISOString(), costs: { '5h': 1000 } },
          { at: new Date(now - hour).toISOString(), costs: { '5h': 980 } },
        ],
      },
    });
    const invocations = [
      { id: 'a', accountId: id, provider: 'no-such-provider', at: new Date(now - 2 * hour).toISOString(), totalTokens: 600, latencyMs: 1 },
      { id: 'b', accountId: id, provider: 'no-such-provider', at: new Date(now - hour).toISOString(), totalTokens: 400, latencyMs: 1 },
    ];
    expect(noteStoredQuota(spent, state([spent], invocations), now)).toBe(0);
    expect(spent.quotaState).toBe('exhausted');
  });
});
