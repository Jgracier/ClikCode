import { describe, expect, it, vi } from 'vitest';
import type { HarnessSession } from '../../session/model.js';

vi.mock('../../gateway/credentials.js', () => ({
  getApiUrl: () => 'https://gateway.example',
  getApiKeyForUrl: () => 'test-key',
}));
vi.mock('../../gateway/models.js', () => ({ gatewayModels: async () => ({ automatic: 'gpt', models: [{ id: 'gpt' }] }) }));

const { modelClientForSession } = await import('./for-session.js');

describe('a selected platform agent before agent execution is wired', () => {
  it('does not alter ClikCode model steps or send agent_id', async () => {
    const now = new Date().toISOString();
    const session: HarnessSession = {
      id: 'gw', route: 'gateway', accountId: null, provider: 'gateway', model: 'gpt', gatewayAgentId: 'silas', effort: 'platform-managed',
createdAt: now, updatedAt: now, status: 'active',
    };
    const client = await modelClientForSession(session, {} as never);
    const fetchImpl = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));
    try {
      await client.step({ system: 'test', items: [], tools: [], onTextDelta: () => undefined } as never);
      const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('https://gateway.example/v1/chat/completions');
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body.model).toBe('gpt');
      expect(body).not.toHaveProperty('agent_id');
    } finally { fetchImpl.mockRestore(); }
  });
});
