import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as catalog from '@clikcode/router/ai-local-harness';

vi.mock('../../runtime/lazy-bridge.js', async (original) => ({
  ...(await original<typeof import('../../runtime/lazy-bridge.js')>()),
  localHarnessForProvider: catalog.localHarnessForProvider,
}));

const { claude, grok, amp } = vi.hoisted(() => ({
  claude: vi.fn(async () => ({ windows: [], label: '5h 10% left' })),
  amp: vi.fn(async () => ({ windows: [], label: '$9.05 credits left' })),
  grok: vi.fn(async () => ({ windows: [{ name: 'weekly', usedPercent: 0, resetsAt: '2999-01-01T00:00:00.000Z' }], label: 'weekly 100% left' })),
}));
vi.mock('./usage-probes.js', async (original) => ({
  ...(await original<typeof import('./usage-probes.js')>()),
  NATIVE_USAGE_PROBES: { claude, grok, amp },
}));
vi.mock('../../session/state/write.js', () => ({ writeState: vi.fn(async () => undefined) }));

const { cachedAccountUsageLabel, nativeUsageReading } = await import('./account-usage.js');
const { recordQuotaRefusal } = await import('../../turn/account-outcome.js');
const { nativeUsageCache } = await import('./usage-reading.js');
import type { HarnessSession, HarnessState } from '../../session/model.js';

const account = { id: 'a', provider: 'anthropic', label: 'a', authKind: 'vendor-cli', models: [], status: 'ready', credentialRef: 'native:a' };
const stateWith = (invocations: HarnessState['invocations'] = []): HarnessState => ({ accounts: [{ ...account }], sessions: [], invocations } as unknown as HarnessState);

beforeEach(() => { nativeUsageCache.clear(); claude.mockClear(); grok.mockClear(); amp.mockClear(); });

describe('usage on a passive paint', () => {
  it('shows each account its own shared usage, including a fresh credit balance', () => {
    const now = Date.now();
    const state = { accounts: [
      { ...account, id: 'one', provider: 'augment', usage: { at: new Date(now).toISOString(), label: '$9 credits left' } },
      { ...account, id: 'two', provider: 'augment', usage: { at: new Date(now).toISOString(), label: '$2 credits left' } },
    ], sessions: [], invocations: [] } as unknown as HarnessState;
    expect(cachedAccountUsageLabel(state.accounts[0]!, state)).toBe('$9 credits left');
    expect(cachedAccountUsageLabel(state.accounts[1]!, state)).toBe('$2 credits left');
    state.accounts[0]!.usage = { at: new Date(now - 6 * 60_000).toISOString(), label: '$9 credits left' };
    expect(cachedAccountUsageLabel(state.accounts[0]!, state)).toBeUndefined();
  });

  // Claude Code's probe is its local /usage now -- no model call -- so a
  // passive paint may run it, and the composer is not blank until an ask.
  it("runs Claude Code's free /usage probe on a passive paint", async () => {
    const session = { id: 's', nativeHarness: 'claude', accountId: 'a' } as HarnessSession;
    expect((await nativeUsageReading(session, stateWith()))?.label).toBe('5h 10% left');
    expect(claude).toHaveBeenCalledTimes(1);
  });

  it('runs a free probe, then reuses its reading until a turn starts on the account', async () => {
    const session = { id: 's', nativeHarness: 'grok', accountId: 'a' } as HarnessSession;
    expect((await nativeUsageReading(session, stateWith()))?.label).toBe('weekly 100% left');
    expect((await nativeUsageReading(session, stateWith()))?.label).toBe('weekly 100% left');
    expect(grok).toHaveBeenCalledTimes(1);
    const later = new Date(Date.now() + 60_000).toISOString();
    await nativeUsageReading(session, stateWith([{ id: 'i', accountId: 'a', provider: 'xai', at: later, latencyMs: 1_000 }]));
    expect(grok).toHaveBeenCalledTimes(2);
  });

  it('asks the harness once when two ask at the same moment', async () => {
    const session = { id: 's', nativeHarness: 'grok', accountId: 'a' } as HarnessSession;
    const [first, second] = await Promise.all([nativeUsageReading(session, stateWith()), nativeUsageReading(session, stateWith())]);
    expect(first?.label).toBe('weekly 100% left');
    expect(second?.label).toBe('weekly 100% left');
    expect(grok).toHaveBeenCalledTimes(1);
  });

  it('never spawns a probe for an account that is not signed in, nor for no account', async () => {
    const signedOut = { accounts: [{ ...account, status: 'needs-login' }], sessions: [], invocations: [] } as unknown as HarnessState;
    expect(await nativeUsageReading({ id: 's', nativeHarness: 'grok', accountId: 'a' } as HarnessSession, signedOut, { network: true })).toBeUndefined();
    expect(await nativeUsageReading({ id: 's', nativeHarness: 'grok' } as HarnessSession, stateWith(), { network: true })).toBeUndefined();
    expect(grok).not.toHaveBeenCalled();
  });

  it('shows a free Grok account its learned usage once it has run out, and keeps the plan name off the window', async () => {
    const weekly = { windows: [{ name: 'weekly', usedPercent: 0, resetsAt: '2999-01-01T00:00:00.000Z' }], label: 'weekly 100% left' };
    grok.mockResolvedValue({ windows: [], label: 'Free plan', plan: { name: 'Free' } });
    try {
      const now = Date.now();
      const hour = 60 * 60_000;
      const user = {
        ...account, id: 'a', provider: 'xai', label: 'grok', plan: { name: 'Free' },
        usage: { at: new Date(now - hour).toISOString(), label: 'Free plan' },
      };
      const invocations: HarnessState['invocations'] = [
        { id: 'before', accountId: 'a', provider: 'xai', at: new Date(now - 25 * hour).toISOString(), latencyMs: 0, totalTokens: 100 },
      ];
      for (let index = 0; index < 10; index += 1) {
        invocations.push({ id: `t${index}`, accountId: 'a', provider: 'xai', at: new Date(now - 23 * hour + index * hour).toISOString(), latencyMs: 0, totalTokens: 100 });
      }
      const state = { accounts: [user], sessions: [], invocations } as unknown as HarnessState;
      recordQuotaRefusal(state, user, new Error('subscription:free-usage-exhausted: Usage resets over a rolling 24-hour window — tokens (actual/limit): 603117/500000'), now);
      const session = { id: 's', nativeHarness: 'grok', accountId: 'a' } as HarnessSession;
      const reading = await nativeUsageReading(session, state);
      expect(reading?.label).toBe('Daily ~0% left');
      expect(reading?.windows[0]?.resetsAt).toBe(user.quotaRetryAt);
      expect(Date.parse(reading!.windows[0]!.resetsAt!)).toBeGreaterThan(now);
      expect(reading?.plan).toEqual({ name: 'Free' });
      expect(user.usage).toMatchObject({ label: 'Free plan' });
      expect(user.usage).not.toHaveProperty('windows');
      const again = await nativeUsageReading(session, state);
      expect(again?.label).toBe('Daily ~0% left');
      expect(grok).toHaveBeenCalledTimes(1);
    } finally {
      grok.mockResolvedValue(weekly);
    }
  });

  it('asks again once a minute has passed, figure or balance, even while its window still holds', async () => {
    for (const [harness, probe] of [['grok', grok], ['amp', amp]] as const) {
      const session = { id: 's', nativeHarness: harness, accountId: 'a' } as HarnessSession;
      const state = stateWith();
      await nativeUsageReading(session, state);
      await nativeUsageReading(session, state);
      expect(probe).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 61_000);
      try {
        await nativeUsageReading(session, state);
        expect(probe).toHaveBeenCalledTimes(2);
      } finally { vi.useRealTimers(); }
    }
  });

  it('does not ask when another window asked within the minute', async () => {
    const session = { id: 's', nativeHarness: 'grok', accountId: 'a' } as HarnessSession;
    const state = stateWith();
    state.accounts[0]!.usage = { at: new Date(Date.now() - 5 * 60_000).toISOString(), label: 'weekly 100% left', windows: [{ name: 'weekly', usedPct: 0, resetsAt: '2999-01-01T00:00:00.000Z' }] } as never;
    state.accounts[0]!.usageCheckedAt = new Date(Date.now() - 10_000).toISOString();
    expect((await nativeUsageReading(session, state))?.label).toBe('weekly 100% left');
    expect(grok).not.toHaveBeenCalled();
  });
});
