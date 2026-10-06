import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { agentTurnSettings, runGatewayAgentTurn } from './gateway-agent-turn.js';

vi.mock('../agent/models/for-session.js', () => ({
  gatewayConnection: () => ({ baseUrl: 'https://app.test', apiKey: 'account-key' }),
}));

const originalHome = process.env.CLIKCODE_HOME;
const originalFetch = globalThis.fetch;
let root: string | undefined;
afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = originalHome;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe('selected Gateway agent turn', () => {
  it('posts to the agent lane, polls the linked answer and saves the thread for the next turn', async () => {
    root = await mkdtemp(join(tmpdir(), 'gateway-agent-turn-'));
    process.env.CLIKCODE_HOME = root;
    const state = await readState();
    const now = new Date().toISOString();
    const session = {
      id: 'gw', route: 'gateway' as const, accountId: null, provider: 'gateway', model: 'model-x',
      effort: 'platform-managed', accountFailover: 'never' as const, createdAt: now, updatedAt: now,
      status: 'active' as const, gatewayAgentId: 'agent-1',
    };
    state.sessions.push(session);
    await writeState(state);
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(init.method === 'POST'
      ? { threadId: 'thread-1', messageId: 'msg-1' }
      : { status: 'completed', text: 'The agent answered.' }), { status: 200 }));
    globalThis.fetch = fetcher as typeof fetch;
    const prompter = { phase: vi.fn(), response: vi.fn() };
    await runGatewayAgentTurn({ config: {} as never, state, session, prompt: 'Please help', run: { prompter: prompter as never } });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://app.test/v1/agents/agent-1/chat');
    expect(JSON.parse(fetcher.mock.calls[0]![1].body as string)).toEqual({ message: 'Please help', threadId: null, model: 'model-x', permissionMode: 'ask' });
    expect(fetcher.mock.calls[1]?.[0]).toContain('threadId=thread-1');
    expect((await readState({ transcripts: ['gw'] })).sessions.find((item) => item.id === 'gw')).toMatchObject({ gatewayAgentThreadId: 'thread-1' });
    expect(prompter.response).toHaveBeenCalledWith('The agent answered.', 'append');
  });

  it('sends the session\'s permission mode and effort, leaving an automatic effort to the agent', () => {
    expect(agentTurnSettings({ model: 'm', effort: 'high', permissionMode: 'bypass' })).toEqual({ model: 'm', effort: 'high', permissionMode: 'bypass' });
    expect(agentTurnSettings({ model: null, effort: 'auto', permissionMode: 'auto' })).toEqual({ model: null, permissionMode: 'auto' });
    expect(agentTurnSettings({ model: 'm', effort: 'platform-managed', permissionMode: undefined })).toEqual({ model: 'm', permissionMode: 'ask' });
  });
});
