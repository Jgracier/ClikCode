/** The editor's model menu lists the account's Gateway agents before its
 * models, as the terminal's /model does, and choosing one is the terminal
 * picker's own step: the chat stays on the Gateway and runs as that agent. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Conf from 'conf';

const roster = vi.fn(async () => [
  { id: 'silas', name: 'Silas', description: 'Watches the platform' },
  { id: 'vera', name: 'Vera' },
]);
vi.mock('../gateway/agents.js', () => ({ gatewayAgents: roster }));
vi.mock('../gateway/models.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../gateway/models.js')>(),
  // Asked afresh on every open: the saved copy must not be what the menu shows.
  gatewayModels: async () => ({ automatic: 'model-a', models: [{ id: 'model-a', access: 'subscription' }, { id: 'model-b' }] }),
  savedGatewayModels: async () => ({ automatic: 'stale', models: [{ id: 'stale' }] }),
}));

const { modelList } = await import('./queries.js');
const { IdeBridge } = await import('./bridge.js');
const { readState } = await import('../session/state/read.js');
const { writeState } = await import('../session/state/write.js');

const previousHome = process.env.CLIKCODE_HOME;
afterEach(() => {
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
  roster.mockClear();
});

const gatewaySession = (extra: Record<string, unknown> = {}) => ({
  id: 'gw', route: 'gateway', accountId: null, provider: 'gateway', model: null, effort: 'platform-managed', createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z', status: 'active', ...extra,
});

async function home(sessions: unknown[]): Promise<void> {
  process.env.CLIKCODE_HOME = await mkdtemp(join(tmpdir(), 'clikcode-ide-agents-'));
  const state = await readState();
  state.sessions.push(...sessions as typeof state.sessions);
  await writeState(state);
}

describe('the Gateway model menu', () => {
  it('lists the account\'s agents, the chat\'s marked, beside the models', async () => {
    await home([gatewaySession({ gatewayAgentId: 'silas' })]);
    const state = await readState();
    const list = await modelList({} as Conf, state, state.sessions[0], 'gateway');
    expect(list.agents).toEqual([
      { id: 'silas', name: 'Silas', detail: 'Watches the platform', current: true },
      { id: 'vera', name: 'Vera', current: false },
    ]);
    expect(list.models.map((model) => model.id)).toEqual(['auto', 'model-a', 'model-b']);
    // The tier serving it, where the Gateway says (the super admin's list); a bare name where it does not.
    expect(list.models.map((model) => model.label)).toEqual(['Automatic', 'model-a (subscription)', 'model-b']);
    expect(list.agentsError).toBeUndefined();
  });

  it('still lists the models when the roster cannot be read, and says why', async () => {
    roster.mockRejectedValueOnce(new Error('ClikDeploy Gateway agents: HTTP 401'));
    await home([gatewaySession()]);
    const state = await readState();
    const list = await modelList({} as Conf, state, state.sessions[0], 'gateway');
    expect(list.agents).toEqual([]);
    expect(list.agentsError).toBe('ClikDeploy Gateway agents: HTTP 401');
    expect(list.models.length).toBe(3);
  });
});

describe('choosing an agent in the editor', () => {
  const bridgeFor = () => {
    const sent: Array<Record<string, unknown>> = [];
    const bridge = new IdeBridge({} as Conf, { send: (message) => { sent.push(message as unknown as Record<string, unknown>); } });
    const inner = bridge as unknown as { sessionId?: string; emitSession(): Promise<void> };
    inner.emitSession = async () => undefined;
    const result = async (requestId: string) => {
      for (let i = 0; i < 50 && !sent.some((item) => item.requestId === requestId); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      return sent.find((item) => item.requestId === requestId);
    };
    return { bridge, inner, result };
  };

  it('stores it on the chat, starts a fresh agent thread, and clears it with null', async () => {
    await home([gatewaySession({ gatewayAgentThreadId: 'old-thread' })]);
    const { bridge, inner, result } = bridgeFor();
    inner.sessionId = 'gw';
    bridge.handle({ type: 'choose', requestId: 'a', choice: { kind: 'agent', agent: 'silas' } });
    expect(await result('a')).toMatchObject({ ok: true });
    let saved = (await readState()).sessions.find((item) => item.id === 'gw');
    expect(saved?.gatewayAgentId).toBe('silas');
    expect(saved?.gatewayAgentThreadId).toBeUndefined();
    bridge.handle({ type: 'choose', requestId: 'b', choice: { kind: 'agent', agent: null } });
    expect(await result('b')).toMatchObject({ ok: true });
    saved = (await readState()).sessions.find((item) => item.id === 'gw');
    expect(saved?.gatewayAgentId).toBeUndefined();
  });

  it('refuses an agent for a chat that is not on the Gateway', async () => {
    await home([gatewaySession({ id: 'local', route: 'local', provider: 'openai' })]);
    const { bridge, inner, result } = bridgeFor();
    inner.sessionId = 'local';
    bridge.handle({ type: 'choose', requestId: 'c', choice: { kind: 'agent', agent: 'silas' } });
    expect(await result('c')).toMatchObject({ ok: false, error: expect.stringMatching(/Gateway session/) });
  });
});
