import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Conf from 'conf';
import { agentMcpServer, gatewayAgentSession, type GatewayAgentSession } from './agent-session.js';
import type { HarnessSession } from '../session/model.js';

vi.mock('../agent/models/for-session.js', () => ({ gatewayConnection: () => ({ baseUrl: 'https://gw.test', apiKey: 'user-key' }) }));

const session = { id: 's1', route: 'gateway', gatewayAgentId: 'agent-1', gatewayAgentName: 'Silas', model: null, permissionMode: 'ask' } as unknown as HarnessSession;
const SPEC: GatewayAgentSession = {
  agent: { id: 'agent-1', handle: 'silas', name: 'Silas' }, system: 'You are @silas.', model: 'claude-opus-5-5', effort: 'high', permissionMode: 'bypass',
  mcp: { path: '/mcp?toolmode=deferred&turn=chat&agent=silas', apiKey: 'agent-key', expiresAt: '2026-10-10T03:00:00.000Z', core: ['admin_ai_read'] },
};

describe('a Gateway agent run as ClikCode\'s own agent', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  it('asks the Gateway for the agent with the session\'s own choices, and gets its prompt, model and tool key', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(SPEC), { status: 200 }));
    expect(await gatewayAgentSession({} as Conf, session)).toEqual(SPEC);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://gw.test/v1/agents/agent-1/session');
    expect(JSON.parse(String(init.body))).toEqual({ permissionMode: 'ask' });
  });

  it('serves the agent\'s tools as an MCP server on the Gateway origin, with the agent\'s own key', () => {
    expect(agentMcpServer({} as Conf, SPEC)).toEqual({
      name: 'silas', transport: 'http', url: 'https://gw.test/mcp?toolmode=deferred&turn=chat&agent=silas',
      headers: { authorization: 'Bearer agent-key' }, core: ['admin_ai_read'],
    });
    expect(agentMcpServer({} as Conf, { ...SPEC, mcp: undefined } as GatewayAgentSession)).toBeUndefined();
  });

  it('an older server (no such route) falls back; an unknown agent or a refusal is an error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
    expect(await gatewayAgentSession({} as Conf, session)).toBeUndefined();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Agent not found' } }), { status: 404 }));
    await expect(gatewayAgentSession({} as Conf, session)).rejects.toThrow('not available');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: '@silas is switched off.' } }), { status: 403 }));
    await expect(gatewayAgentSession({} as Conf, session)).rejects.toThrow('@silas is switched off.');
  });
});
