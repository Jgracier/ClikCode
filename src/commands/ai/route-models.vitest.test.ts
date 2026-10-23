/** Switching away from a route and back lands on the model last used there: the
 * Gateway, ClikCode Local and every vendor harness alike. CLIKCODE_HOME is
 * throwaway; selecting the harness (install, sign-in) is stubbed. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessSession } from '../../session/model.js';
import { readState } from '../../session/state/read.js';
import { writeState } from '../../session/state/write.js';
import { restoreNativeThread } from '../../session/native-thread.js';

vi.mock('./harness.js', () => ({ aiHarnessSelect: async () => undefined }));
vi.mock('../../worker/turn-bridge.js', () => ({ workerTurn: async () => undefined }));
const { moveToProvider } = await import('./conversations.js');
const { applyClikCodeAgentSessionPolicy } = await import('./sessions.js');

const saved = process.env.CLIKCODE_HOME;
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'cc-routes-')); process.env.CLIKCODE_HOME = root; });
afterEach(async () => {
  if (saved === undefined) delete process.env.CLIKCODE_HOME; else process.env.CLIKCODE_HOME = saved;
  await rm(root, { recursive: true, force: true });
});

async function chat(fields: Partial<HarnessSession>): Promise<void> {
  const state = await readState();
  const now = new Date().toISOString();
  state.sessions.push({
    id: 's1', conversationId: 's1', route: 'gateway', accountId: null, provider: 'gateway', model: 'glm-5',
    effort: 'medium', permissionMode: 'ask', createdAt: now, updatedAt: now, status: 'active', gatewayConfirmed: true, ...fields,
  } as HarnessSession);
  await writeState(state);
}
const only = async (): Promise<HarnessSession> => (await readState()).sessions.find((item) => item.id === 's1')!;
async function toGateway(): Promise<void> {
  const state = await readState();
  applyClikCodeAgentSessionPolicy(state.sessions.find((item) => item.id === 's1')!, 'gateway', state);
  await writeState(state);
}

describe('the model last used on a route', () => {
  it('is back on the Gateway after a harness: the Gateway model, not Automatic', async () => {
    await chat({});
    await moveToProvider('s1', 'codex', { model: 'gpt-5' });
    expect((await only()).model).toBe('gpt-5');
    await toGateway();
    expect(await only()).toMatchObject({ route: 'gateway', provider: 'gateway', model: 'glm-5' });
  });

  it('is back on a harness the same way, whatever route it went through', async () => {
    await chat({});
    await moveToProvider('s1', 'codex', { model: 'gpt-5' });
    await moveToProvider('s1', 'claude', { model: 'opus' });
    await toGateway();
    await moveToProvider('s1', 'codex');
    expect((await only()).model).toBe('gpt-5');
    await moveToProvider('s1', 'claude');
    expect((await only()).model).toBe('opus');
  });

  it('persists a parked native thread through another harness and the Gateway', async () => {
    await chat({
      route: 'local', provider: 'openai', nativeHarness: 'codex', nativeSessionId: 'codex-thread',
      model: 'gpt-5', gatewayConfirmed: undefined,
      messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'done' }],
    });
    await moveToProvider('s1', 'claude', { model: 'opus' });
    expect((await only()).nativeThreads?.codex).toMatchObject({ id: 'codex-thread', through: 2 });
    await toGateway();
    expect((await only()).nativeThreads?.codex?.id).toBe('codex-thread');
    await moveToProvider('s1', 'codex');
    const returned = await only();
    expect(restoreNativeThread(returned, 'codex')).toBe(2);
    expect(returned.nativeSessionId).toBe('codex-thread');
  });

  it('remembers Automatic as a choice', async () => {
    await chat({ model: null });
    await moveToProvider('s1', 'codex', { model: 'gpt-5' });
    await toGateway();
    expect((await only()).model).toBeNull();
  });

  it('starts a conversation that never used the route on what the latest conversation there used', async () => {
    await chat({ id: 'other', conversationId: 'other', model: 'kimi-k3', updatedAt: new Date(Date.now() + 1000).toISOString() });
    await chat({ id: 's1', conversationId: 's1', route: 'local', provider: 'openai', nativeHarness: 'codex', model: 'gpt-5', gatewayConfirmed: undefined });
    await toGateway();
    expect((await only()).model).toBe('kimi-k3');
  });
});
