import { describe, expect, it, vi } from 'vitest';

vi.mock('../agent/models/for-session.js', () => ({
  gatewayConnection: () => ({ baseUrl: 'https://clikdeploy.com', apiKey: 'account-private-key' }),
}));

const { gatewayAgents } = await import('./agents.js');

describe('the Gateway account agent roster', () => {
  it('reads only the account-scoped endpoint with the connected key', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: 'agent-1', name: 'Silas', description: 'Improves the platform' },
      { id: 'agent-2', name: 'ClikNet' },
      { name: 'invalid' },
    ] }), { status: 200 }));
    expect(await gatewayAgents({ fetchImpl: fetchImpl as never })).toEqual([
      { id: 'agent-1', name: 'Silas', description: 'Improves the platform' },
      { id: 'agent-2', name: 'ClikNet' },
    ]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://clikdeploy.com/v1/agents');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer account-private-key');
    await gatewayAgents({ fetchImpl: fetchImpl as never });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects a missing or malformed roster', async () => {
    await expect(gatewayAgents({ fetchImpl: (async () => new Response('not found', { status: 404 })) as never })).rejects.toThrow('HTTP 404');
    await expect(gatewayAgents({ fetchImpl: (async () => new Response(JSON.stringify({ agents: [] }))) as never })).rejects.toThrow();
  });
});
