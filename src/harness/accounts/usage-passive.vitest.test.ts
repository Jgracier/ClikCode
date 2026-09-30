import { beforeEach, describe, expect, it, vi } from 'vitest';

const { claude, grok } = vi.hoisted(() => ({
  claude: vi.fn(async () => '5h 10% left'),
  grok: vi.fn(async () => ({ windows: [{ name: 'weekly', usedPercent: 0, resetsAt: '2999-01-01T00:00:00.000Z' }], label: 'weekly 100% left' })),
}));
vi.mock('./usage-probes.js', async (original) => {
  const grokLabel = async () => 'weekly 100% left';
  return {
    ...(await original<typeof import('./usage-probes.js')>()),
    NATIVE_USAGE_PROBES: { claude, grok: grokLabel },
    NATIVE_USAGE_READING_PROBES: { grok: { label: grokLabel, reading: grok } },
  };
});
vi.mock('../../session/state/write.js', () => ({ writeState: vi.fn(async () => undefined) }));

const { nativeUsageReading } = await import('./account-usage.js');
const { nativeUsageCache } = await import('./usage-reading.js');
import type { HarnessSession, HarnessState } from '../../session/model.js';

const account = { id: 'a', provider: 'anthropic', label: 'a', authKind: 'vendor-cli', models: [], status: 'ready', credentialRef: 'native:a' };
const stateWith = (invocations: HarnessState['invocations'] = []): HarnessState => ({ accounts: [{ ...account }], sessions: [], invocations } as unknown as HarnessState);

beforeEach(() => { nativeUsageCache.clear(); claude.mockClear(); grok.mockClear(); });

describe('usage on a passive paint', () => {
  it('never runs a billed probe (a real Claude Code turn) without an explicit ask', async () => {
    const session = { id: 's', nativeHarness: 'claude', accountId: 'a' } as HarnessSession;
    expect(await nativeUsageReading(session, stateWith())).toBeUndefined();
    expect(claude).not.toHaveBeenCalled();
    expect((await nativeUsageReading(session, stateWith(), { network: true }))?.label).toBe('5h 10% left');
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
});
