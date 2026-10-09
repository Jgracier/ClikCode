import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Conf from 'conf';
import { seedAgentThread } from './gateway-agent-turn.js';
import type { HarnessSession } from '../session/model.js';

vi.mock('../agent/models/for-session.js', () => ({ gatewayConnection: () => ({ baseUrl: 'https://gw.test', apiKey: 'k' }) }));
vi.mock('../runtime/lazy-bridge.js', () => ({ localHarnessForCommand: () => ({ displayName: 'Claude Code' }) }));

const session = (messages: HarnessSession['messages']): HarnessSession => ({
  id: 's1', conversationId: 's1', route: 'gateway', accountId: null, provider: 'gateway', model: 'claude-opus-5-5',
  effort: 'high', permissionMode: 'bypass', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  status: 'active', messages,
} as HarnessSession);
const history = [
  { role: 'user', content: 'fix the parser', at: '2026-01-01T00:00:00.000Z' },
  { role: 'assistant', content: 'Fixed it in parse.ts.', at: '2026-01-01T00:00:01.000Z' },
] as HarnessSession['messages'];

describe('seedAgentThread', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  it('hands the conversation to the agent at the switch and keeps the thread it was given', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ threadId: 'thread-9' }), { status: 201 }));
    expect(await seedAgentThread({} as Conf, session(history), 'agent-1')).toBe('thread-9');
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://gw.test/v1/agents/agent-1/threads');
    const body = JSON.parse(String(init.body)) as Record<string, string>;
    expect(body.context).toContain('fix the parser');
    expect(body.context).toContain('Fixed it in parse.ts.');
    // The session's own settings, the same ones its turns send: the warm-up reads the same prompt.
    expect(body).toMatchObject({ model: 'claude-opus-5-5', permissionMode: 'bypass', effort: 'high' });
  });

  it('sends nothing for a blank chat, and gives up quietly on a server that cannot take it', async () => {
    expect(await seedAgentThread({} as Conf, session([]), 'agent-1')).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(new Response('{}', { status: 404 }));
    expect(await seedAgentThread({} as Conf, session(history), 'agent-1')).toBeUndefined();
    fetchMock.mockRejectedValue(new Error('offline'));
    expect(await seedAgentThread({} as Conf, session(history), 'agent-1')).toBeUndefined();
  });
});
