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
vi.mock('../../gateway/models.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  savedGatewayModels: catalog.saved,
  gatewayModels: catalog.fresh,
}));

const { modelClientForSession } = await import('./for-session.js');
const session = (attachments: string[] = []): HarnessSession => ({
  id: 's1', route: 'gateway', model: 'vision-model', attachments,
} as HarnessSession);

describe('Gateway turn startup', () => {
  it('starts without a model-list network request when a list is saved', async () => {
    catalog.saved.mockResolvedValue({ auto: null, models: [{ id: 'vision-model', contextWindow: 50_000 }] });
    catalog.fresh.mockClear();
    const client = await modelClientForSession(session(), { get: () => undefined } as never);
    expect(client.contextHints?.contextWindow).toBe(50_000);
    expect(catalog.fresh).not.toHaveBeenCalled();
  });

  it('fetches the list before the first step when none is saved, instead of assuming a window and no vision', async () => {
    catalog.saved.mockResolvedValue(undefined);
    catalog.fresh.mockReset();
    catalog.fresh.mockResolvedValue({ auto: null, models: [{ id: 'vision-model', vision: true, contextWindow: 200_000, maxOutput: 16_000 }] });
    const client = await modelClientForSession(session(), { get: () => undefined } as never);
    expect(catalog.fresh).toHaveBeenCalledOnce();
    expect(client.contextHints?.contextWindow).toBe(200_000);
    expect(client.acceptsImages).toBe(true);
  });

  it('runs the turn on what it has when that first fetch fails', async () => {
    catalog.saved.mockResolvedValue(undefined);
    catalog.fresh.mockReset();
    catalog.fresh.mockRejectedValue(new Error('timed out'));
    const client = await modelClientForSession(session(), { get: () => undefined } as never);
    expect(client).toBeDefined();
    expect(catalog.fresh).toHaveBeenCalledOnce();
  });

  it('fetches missing vision facts when an image needs them', async () => {
    catalog.saved.mockResolvedValue({ auto: null, models: [] });
    catalog.fresh.mockReset();
    catalog.fresh.mockResolvedValue({ auto: null, models: [{ id: 'vision-model', vision: true, contextWindow: 100_000 }] });
    const client = await modelClientForSession(session(["/tmp/shot.png"]), { get: () => undefined } as never);
    expect(catalog.fresh).toHaveBeenCalledOnce();
    expect(client.acceptsImages).toBe(true);
    expect(client.contextHints?.contextWindow).toBe(100_000);
  });

  it('refreshes an unknown selected model without requiring image attachments', async () => {
    catalog.saved.mockResolvedValue({ auto: null, models: [] });
    catalog.fresh.mockReset();
    catalog.fresh.mockResolvedValue({ auto: null, models: [{ id: 'vision-model', contextWindow: 32768 }] });
    const client = await modelClientForSession(session(), { get: () => undefined } as never);
    expect(catalog.fresh).toHaveBeenCalledOnce();
    expect(client.contextHints?.contextWindow).toBe(32768);
  });

  it('runs Automatic under the facts the Gateway lists for auto, never a named model\'s', async () => {
    catalog.saved.mockResolvedValue({ auto: { contextWindow: 64_000, vision: true }, models: [{ id: 'other', contextWindow: 999_000 }] });
    const client = await modelClientForSession({ ...session(), model: null } as HarnessSession, { get: () => undefined } as never);
    expect(client.contextHints?.contextWindow).toBe(64_000);
    expect(client.acceptsImages).toBe(true);
  });
});
