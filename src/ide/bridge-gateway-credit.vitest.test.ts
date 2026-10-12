import { describe, expect, it, vi } from 'vitest';
import type Conf from 'conf';

const hoisted = vi.hoisted(() => ({
  session: { id: 's1', route: 'gateway', service: 'gateway' } as Record<string, unknown>,
  label: 'Unlimited credit' as string | undefined,
  native: vi.fn(async () => ({ label: '5h 42% left' })),
}));

vi.mock('../session/state/read.js', () => ({ readState: async () => ({ sessions: [hoisted.session], accounts: [] }) }));
vi.mock('../tui/slash/usage-report.js', () => ({ conversationCost: () => undefined }));
vi.mock('../session/route.js', async (original) => ({
  ...(await original<typeof import('../session/route.js')>()),
  isGatewayService: (session: { service?: string }) => session.service === 'gateway',
}));
vi.mock('../harness/accounts/account-usage.js', () => ({ nativeUsageReading: hoisted.native, recheckRecoveredAccounts: async () => undefined }));
vi.mock('../gateway/credit-label.js', () => ({ gatewayCreditLabel: async () => hoisted.label }));

const { IdeBridge } = await import('./bridge.js');

async function usageEvent(service: string) {
  hoisted.session = { id: 's1', service };
  const sent: unknown[] = [];
  const bridge = new IdeBridge({} as Conf, { send: (event: unknown) => { sent.push(event); } } as never);
  (bridge as unknown as { sessionId: string }).sessionId = 's1';
  await (bridge as unknown as { refreshUsage: () => Promise<void> }).refreshUsage();
  return sent.find((event) => (event as { type: string }).type === 'usage') as { label?: string } | undefined;
}

describe('the editor bar shows the Gateway credit for a Gateway chat', () => {
  it('reads the credit, not a vendor plan window', async () => {
    hoisted.native.mockClear();
    expect((await usageEvent('gateway'))?.label).toBe('Unlimited credit');
    expect(hoisted.native).not.toHaveBeenCalled();
  });

  it('leaves a vendor chat on its own reading', async () => {
    expect((await usageEvent('vendor'))?.label).toBe('5h 42% left');
  });

  it('says nothing when the Gateway gave no figure', async () => {
    hoisted.label = undefined;
    expect((await usageEvent('gateway'))?.label).toBeUndefined();
  });
});
