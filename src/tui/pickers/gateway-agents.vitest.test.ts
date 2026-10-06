import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatewayPickerRows } from './model.js';
import { selectGatewayAgent, applyClikCodeLocalSessionPolicy, aiSessionSet } from '../../commands/ai/sessions.js';
import { readState } from '../../session/state/read.js';
import { writeState } from '../../session/state/write.js';
import type { HarnessSession } from '../../session/model.js';

vi.mock('../../gateway/agents.js', () => ({ gatewayAgents: async () => [{ id: 'silas', name: 'Silas' }] }));
vi.mock('../../gateway/models.js', () => ({
  savedGatewayModels: async () => ({ automatic: 'gpt', models: [{ id: 'gpt' }] }),
  gatewayModels: async () => ({ automatic: 'gpt', models: [{ id: 'gpt' }] }),
  gatewayModelDetail: () => '',
  isAutomaticModelWord: (word: string) => word === 'auto',
}));
vi.mock('../../runtime/lazy-bridge.js', async (importOriginal) => {
  const router = await import('@clikcode/router/ai-local-harness') as Record<string, unknown>;
  const original = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(Object.keys(original).map((name) => [name, router[name] ?? original[name]]));
});

const previousHome = process.env.CLIKCODE_HOME;
let root: string | undefined;
afterEach(async () => {
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe('Gateway agents in /model', () => {
  it('lists agents first, checks the selected agent, and leaves models below', () => {
    const list = { automatic: 'gpt', models: [{ id: 'gpt' }] };
    const agents = [{ id: 'silas', name: 'Silas' }, { id: 'cliknet', name: 'ClikNet' }];
    const rows = gatewayPickerRows(list, agents, 'gpt', 'silas');
    expect(rows.map((row) => row.label)).toEqual(['No agent', '✓ Silas', 'ClikNet', 'Agent default', 'gpt']);
    expect(rows.map((row) => row.group)).toEqual(['Agents', 'Agents', 'Agents', 'Models', 'Models']);
    expect(rows[1]!.value).toEqual({ kind: 'agent', id: 'silas' });
    expect(rows[4]!.value).toEqual({ kind: 'model', id: 'gpt' });
  });

  it('persists the agent per Gateway session and sheds it on a local route', async () => {
    root = await mkdtemp(join(tmpdir(), 'cc-gateway-agent-'));
    process.env.CLIKCODE_HOME = root;
    const state = await readState();
    const now = new Date().toISOString();
    const session: HarnessSession = {
      id: 'gw', route: 'gateway', accountId: null, provider: 'gateway', model: 'gpt', effort: 'platform-managed',
      accountFailover: 'never', createdAt: now, updatedAt: now, status: 'active',
    };
    state.sessions.push(session);
    await writeState(state);
    await selectGatewayAgent('gw', 'silas');
    expect((await readState()).sessions.find((item) => item.id === 'gw')).toMatchObject({ gatewayAgentId: 'silas', model: 'gpt' });
    await selectGatewayAgent('gw', undefined);
    expect((await readState()).sessions.find((item) => item.id === 'gw')?.gatewayAgentId).toBeUndefined();
    session.gatewayAgentId = 'silas';
    applyClikCodeLocalSessionPolicy(session);
    expect(session.gatewayAgentId).toBeUndefined();
  });

  it('keeps the picker open after an agent and closes it after a model', async () => {
    root = await mkdtemp(join(tmpdir(), 'cc-gateway-picker-'));
    process.env.CLIKCODE_HOME = root;
    const state = await readState();
    const now = new Date().toISOString();
    state.sessions.push({
      id: 'gw', route: 'gateway', accountId: null, provider: 'gateway', model: null, effort: 'platform-managed',
      accountFailover: 'never', createdAt: now, updatedAt: now, status: 'active',
      messages: [{ role: 'user', content: 'hello' }],
    });
    await writeState(state);
    const select = vi.fn(async (_title: string, rows: ReturnType<typeof gatewayPickerRows>) => {
      if (select.mock.calls.length === 1) return rows.find((row) => row.value.kind === 'agent' && row.value.id === 'silas')!.value;
      expect(rows.find((row) => row.value.kind === 'agent' && row.value.id === 'silas')?.label).toBe('✓ Silas');
      return rows.find((row) => row.value.kind === 'model' && row.value.id === 'gpt')!.value;
    });
    const { interactiveModelPicker } = await import('./model.js');
    await interactiveModelPicker({ select, notice: () => undefined } as never, 'gw');
    expect(select).toHaveBeenCalledTimes(2);
    expect((await readState()).sessions.find((item) => item.id === 'gw')).toMatchObject({ gatewayAgentId: 'silas', model: 'gpt' });
    await aiSessionSet('gw', { route: 'local' });
    expect((await readState()).sessions.find((item) => item.id === 'gw')?.gatewayAgentId).toBeUndefined();
  });
});
