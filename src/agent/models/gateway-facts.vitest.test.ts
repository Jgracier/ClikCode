import { describe, expect, it, vi } from 'vitest';
import type { HarnessSession } from '../../session/model.js';

const catalog = vi.hoisted(() => ({
  saved: vi.fn(),
  fresh: vi.fn(),
}));
vi.mock('../../gateway/credentials.js', () => ({
  getApiUrl: () => 'https://gateway.test',
  getApiKeyForUrl: () => 'test-key',
}));
vi.mock('../../gateway/models.js', () => ({
  savedGatewayModels: catalog.saved,
  gatewayModels: catalog.fresh,
}));

const { modelClientForSession } = await import('./for-session.js');
const session = (attachments: string[] = []): HarnessSession => ({
  id: 's1', route: 'gateway', model: 'vision-model', attachments,
} as HarnessSession);

describe('Gateway turn startup', () => {
  it('starts without a model-list network request for a text turn', async () => {
    catalog.saved.mockResolvedValue(undefined);
    catalog.fresh.mockClear();
    const client = await modelClientForSession(session(), {} as never);
    expect(client).toBeDefined();
    expect(catalog.fresh).not.toHaveBeenCalled();
  });

  it('fetches missing vision facts when an image needs them', async () => {
    catalog.saved.mockResolvedValue(undefined);
    catalog.fresh.mockResolvedValue({ automatic: 'vision-model', models: [{ id: 'vision-model', vision: true, contextWindow: 100_000 }] });
    const client = await modelClientForSession(session(['/tmp/shot.png']), {} as never);
    expect(catalog.fresh).toHaveBeenCalledOnce();
    expect(client.acceptsImages).toBe(true);
    expect(client.contextHints?.contextWindow).toBe(100_000);
  });
});
