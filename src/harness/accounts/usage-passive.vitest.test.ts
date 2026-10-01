import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as catalog from '@clikcode/router/ai-local-harness';

vi.mock('../../runtime/lazy-bridge.js', async (original) => ({
  ...(await original<typeof import('../../runtime/lazy-bridge.js')>()),
  localHarnessForProvider: catalog.localHarnessForProvider,
}));

const { claude, grok, amp } = vi.hoisted(() => ({
  claude: vi.fn(async () => '5h 10% left'),
  amp: vi.fn(async () => '$9.05 credits left'),
  grok: vi.fn(async () => ({ windows: [{ name: 'weekly', usedPercent: 0, resetsAt: '2999-01-01T00:00:00.000Z' }], label: 'weekly 100% left' })),
}));
vi.mock('./usage-probes.js', async (original) => {
  const grokLabel = async () => 'weekly 100% left';
  return {
    ...(await original<typeof import('./usage-probes.js')>()),
    NATIVE_USAGE_PROBES: { claude, grok: grokLabel, amp },
    NATIVE_USAGE_READING_PROBES: { grok: { label: grokLabel, reading: grok } },
  };
});
vi.mock('../../session/state/write.js', () => ({ writeState: vi.fn(async () => undefined) }));

const { cachedAccountUsageLabel, nativeUsageReading } = await import('./account-usage.js');
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

  it('never spawns a probe for an account that is not signed in, nor for no account', async () => {
    const signedOut = { accounts: [{ ...account, status: 'needs-login' }], sessions: [], invocations: [] } as unknown as HarnessState;
    expect(await nativeUsageReading({ id: 's', nativeHarness: 'grok', accountId: 'a' } as HarnessSession, signedOut, { network: true })).toBeUndefined();
    expect(await nativeUsageReading({ id: 's', nativeHarness: 'grok' } as HarnessSession, stateWith(), { network: true })).toBeUndefined();
    expect(grok).not.toHaveBeenCalled();
  });

  it('reuses a windowless balance for a few minutes instead of asking on every tick', async () => {
    const session = { id: 's', nativeHarness: 'amp', accountId: 'a' } as HarnessSession;
    expect((await nativeUsageReading(session, stateWith()))?.label).toBe('$9.05 credits left');
    expect((await nativeUsageReading(session, stateWith()))?.label).toBe('$9.05 credits left');
    expect(amp).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 6 * 60_000);
    try {
      await nativeUsageReading(session, stateWith());
      expect(amp).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});
