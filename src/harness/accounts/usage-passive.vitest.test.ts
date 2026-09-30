import { describe, expect, it, vi } from 'vitest';

const probe = vi.fn(async () => '5h 10% left');
vi.mock('./usage-probes.js', async (original) => ({
  ...(await original<typeof import('./usage-probes.js')>()),
  NATIVE_USAGE_PROBES: { claude: probe },
  NATIVE_USAGE_READING_PROBES: {},
}));
vi.mock('../../session/state/write.js', () => ({ writeState: vi.fn(async () => undefined) }));

const { nativeUsageReading } = await import('./account-usage.js');
import type { HarnessSession, HarnessState } from '../../session/model.js';

const session = { id: 's', nativeHarness: 'claude', accountId: 'a' } as HarnessSession;
const state = { accounts: [{ id: 'a', provider: 'anthropic', label: 'a', authKind: 'vendor-cli', models: [], status: 'ready', credentialRef: 'native:a' }], sessions: [], invocations: [] } as unknown as HarnessState;

describe('usage on a passive paint', () => {
  it('never runs the probe (a real Claude Code turn) without an explicit ask', async () => {
    expect(await nativeUsageReading(session, state)).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
    expect((await nativeUsageReading(session, state, { network: true }))?.label).toBe('5h 10% left');
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
