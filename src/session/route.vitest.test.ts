import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clikCodeAgentLabel, isAiHarnessRoute, isClikCodeAgent, isGatewayService } from './route';
import { providerPickerOptions, sessionPermissionModes, VALID_PERMISSION_MODES } from './options';
import { sessionProviderLabel } from '../harness/protocol/labels';
import { applyClikCodeLocalSessionPolicy, applyGatewaySessionPolicy } from '../commands/ai/sessions';
import { newConversationSession } from '../commands/ai/conversations';
import { resolveSlashCommand } from '../tui/slash/registry';
import { compactConversation } from '../tui/slash/compact';
import { capabilitiesText } from '../tui/slash/capabilities-text';
import { contextUsageText } from '../tui/slash/cost';
import { modelClientForSession } from '../agent/models/for-session';
import { OpenAIModelClient } from '../agent/models/openai-client';
import { aiGatewaySessionSend } from '../turn/drive';
import { readState } from './state/read';
import { writeState } from './state/write';
import type { HarnessSession, HarnessState } from './model';

// The engine is mocked: these tests are about what the seam does with it,
// and the real one would probe this machine and start a llama-server.
const engine = vi.hoisted(() => ({ ensureLocalModel: vi.fn() }));
vi.mock('../local-models/index', async (importOriginal) => ({
  ...await importOriginal<typeof import('../local-models/index')>(),
  ensureLocalModel: engine.ensureLocalModel,
  releaseLocalModelsOnExit: () => undefined,
}));

const session = (overrides: Partial<HarnessSession> = {}): HarnessSession => ({
  id: 's1', conversationId: 's1', route: 'local', accountId: 'acct', provider: 'vendor', model: 'm', effort: 'high',
  permissionMode: 'auto', accountFailover: 'on-quota-exhausted', nativeHarness: 'vendor', nativeSessionId: 'native-1',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'active', ...overrides,
});
const local = (): HarnessSession => session({ route: 'clikcode-local', accountId: null, provider: 'clikcode-local', model: null, effort: 'auto', accountFailover: 'never', nativeHarness: undefined, nativeSessionId: undefined });
const gateway = (): HarnessSession => session({ route: 'gateway', accountId: null, provider: 'gateway', model: null, effort: 'platform-managed', accountFailover: 'never', nativeHarness: undefined, nativeSessionId: undefined });
const emptyState = (): HarnessState => ({ sessions: [], accounts: [], invocations: [], providerSettings: {}, globalSettings: { effort: 'medium', permissionMode: 'ask', accountFailover: 'on-quota-exhausted' } } as unknown as HarnessState);

describe('the two meanings of a route', () => {
  it('ClikCode\'s own agent runs on the Gateway and on ClikCode Local; the Gateway service is the Gateway alone', () => {
    expect([isClikCodeAgent(gateway()), isClikCodeAgent(local()), isClikCodeAgent(session())]).toEqual([true, true, false]);
    expect([isGatewayService(gateway()), isGatewayService(local()), isGatewayService(session())]).toEqual([true, false, false]);
    expect(isClikCodeAgent(undefined)).toBe(false);
    expect(isGatewayService(undefined)).toBe(false);
  });

  it('accepts exactly the three routes', () => {
    expect(['local', 'gateway', 'clikcode-local'].every(isAiHarnessRoute)).toBe(true);
    expect(isAiHarnessRoute('remote')).toBe(false);
  });

  it('names each route by the inference behind it', () => {
    expect(clikCodeAgentLabel(local())).toBe('ClikCode Local');
    expect(sessionProviderLabel(local())).toBe('ClikCode Local');
    expect(sessionProviderLabel(gateway())).toBe('ClikDeploy Gateway');
    expect(contextUsageText(local())).toMatch(/^ClikCode Local has not reported/);
    expect(capabilitiesText(local())).toMatch(/^ClikCode Local capabilities/);
    expect(capabilitiesText(gateway())).toMatch(/^ClikDeploy Gateway capabilities/);
  });
});

describe('a ClikCode Local session is ClikCode\'s own agent', () => {
  it('offers every permission mode, since the agent implements them itself', () => {
    expect(sessionPermissionModes(local(), undefined)).toEqual(VALID_PERMISSION_MODES);
    expect(sessionPermissionModes(gateway(), undefined)).toEqual(VALID_PERMISSION_MODES);
  });

  it('has no vendor-harness slash commands, and says why in its own name', () => {
    for (const name of ['native', 'login', 'effort', 'options']) {
      const availability = resolveSlashCommand(name)!.availability(local(), undefined);
      expect(availability.available, `/${name} offered on ClikCode Local`).toBe(false);
      expect(availability.reason).toContain('ClikCode Local');
    }
    // The Gateway's reasons are unchanged; its model is the user's to choose.
    expect(resolveSlashCommand('effort')!.availability(gateway(), undefined).reason).toContain('ClikDeploy Gateway');
    expect(resolveSlashCommand('model')!.availability(gateway(), undefined).available).toBe(true);
    // /model picks from ClikCode Local's own catalog.
    for (const name of ['permissions', 'add-dir', 'init', 'review', 'model']) {
      expect(resolveSlashCommand(name)!.availability(local(), undefined).available, `/${name} refused on ClikCode Local`).toBe(true);
    }
  });

  it('does not offer /compact on either agent route, because the agent compacts itself', async () => {
    for (const routed of [local(), gateway()]) {
      expect(resolveSlashCommand('compact')!.availability(routed, undefined)).toMatchObject({ available: false, reason: expect.stringContaining('compacts its context') });
      await expect(compactConversation(routed.id, routed, '', async () => undefined)).rejects.toThrow(/compacts its context/);
    }
  });

  it('switching to it sheds the vendor harness and keeps the approval mode', () => {
    const switched = session();
    applyClikCodeLocalSessionPolicy(switched);
    expect(switched).toMatchObject({ route: 'clikcode-local', accountId: null, provider: 'clikcode-local', model: null, effort: 'auto', permissionMode: 'auto', accountFailover: 'never' });
    expect(switched.nativeHarness).toBeUndefined();
    expect(switched.nativeSessionId).toBeUndefined();
    expect(switched.gatewayConfirmed).toBeUndefined();
    // And the Gateway's own policy is what it always was.
    const toGateway = session();
    applyGatewaySessionPolicy(toGateway);
    expect(toGateway).toMatchObject({ route: 'gateway', provider: 'gateway', effort: 'platform-managed', gatewayConfirmed: true });
  });

  it('/new stays on ClikCode Local with no account and the same approval mode', () => {
    const fresh = newConversationSession(emptyState(), { ...local(), permissionMode: 'bypass' });
    expect(fresh).toMatchObject({ route: 'clikcode-local', accountId: null, provider: 'clikcode-local', permissionMode: 'bypass' });
    expect(fresh.nativeHarness).toBeUndefined();
    // Gateway /new is unchanged: no stored mode.
    expect(newConversationSession(emptyState(), gateway()).permissionMode).toBeUndefined();
  });
});

describe('the provider picker', () => {
  it('always lists ClikCode Local, right after the Gateway, and marks it current', () => {
    const rows = providerPickerOptions([], session(), false);
    expect(rows.map((row) => row.label)).toEqual(['ClikDeploy Gateway', 'ClikCode Local']);
    expect(rows[1]).toMatchObject({ value: { kind: 'clikcode-local' }, detail: '· local models on this machine' });
    expect(providerPickerOptions([], local(), false)[1]!.detail).toContain('current');
    expect(providerPickerOptions([], gateway(), true)[1]!.detail).not.toContain('current');
  });
});

describe('the model-client seam', () => {
  const config = { get: () => undefined } as never;

  beforeEach(() => {
    engine.ensureLocalModel.mockReset();
    engine.ensureLocalModel.mockResolvedValue({ baseUrl: 'http://127.0.0.1:4321/v1', model: 'qwen3.5-4b', contextWindow: 32768 });
  });

  it('runs ClikCode Local on the engine\'s endpoint, with its /v1 not doubled', async () => {
    const routed = local();
    const client = await modelClientForSession(routed, config);
    expect(client).toBeInstanceOf(OpenAIModelClient);
    expect(engine.ensureLocalModel).toHaveBeenCalledWith({ sessionId: 's1' });
    // The session now names what the engine chose, so its later turns stay on it.
    expect(routed.model).toBe('qwen3.5-4b');
    const seen: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      seen.push(String(url), JSON.parse(String(init?.body)).model);
      throw new Error('refused');
    });
    try {
      await expect(client.step({ system: 's', items: [], tools: [] } as never)).rejects.toThrow(/ClikCode Local at http:\/\/127\.0\.0\.1:4321/);
    } finally { fetchSpy.mockRestore(); }
    expect(seen).toEqual(['http://127.0.0.1:4321/v1/chat/completions', 'qwen3.5-4b']);
  });

  it('asks the engine for the session\'s own model, passes progress through, and reports its notice', async () => {
    engine.ensureLocalModel.mockResolvedValue({ baseUrl: 'http://127.0.0.1:1/v1', model: 'gpt-oss-20b', contextWindow: 8192, notice: 'slow here' });
    const progress = vi.fn();
    const notice = vi.fn();
    const routed = { ...local(), model: 'gpt-oss-20b' };
    await modelClientForSession(routed, config, { progress, notice });
    expect(engine.ensureLocalModel).toHaveBeenCalledWith({ modelId: 'gpt-oss-20b', sessionId: 's1', progress });
    expect(notice).toHaveBeenCalledWith('slow here');
  });

  it('fails as the engine fails, before any client exists', async () => {
    engine.ensureLocalModel.mockRejectedValue(new Error('Ornith would exceed the memory this machine can spare'));
    await expect(modelClientForSession(local(), config)).rejects.toThrow(/exceed the memory/);
  });

  it('refuses a vendor-harness session, which never runs this agent', async () => {
    await expect(modelClientForSession(session(), config)).rejects.toThrow(/vendor harness/);
  });

  describe('a turn on a ClikCode Local session', () => {
    const previousHome = process.env.CLIKCODE_HOME;
    beforeEach(() => { process.env.CLIKCODE_HOME = mkdtempSync(join(tmpdir(), 'cc-route-')); });
    afterEach(() => {
      if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
      else process.env.CLIKCODE_HOME = previousHome;
    });

    it('takes the agent path, fails at the seam, and records no turn', async () => {
      engine.ensureLocalModel.mockRejectedValue(new Error('the local model did not start'));
      const state = await readState();
      state.sessions.push({ ...local(), workspace: process.env.CLIKCODE_HOME! });
      await writeState(state);
      // Not "no account selected": that would mean it went down the vendor
      // harness path. Not a Gateway sign-in error either.
      await expect(aiGatewaySessionSend(config, 's1', 'hello')).rejects.toThrow('the local model did not start');
      const after = (await readState()).sessions.find((item) => item.id === 's1')!;
      expect(after.messages ?? []).toEqual([]);
      expect(after.pendingTurn).toBeUndefined();
      expect((await readState()).invocations).toEqual([]);
    });
  });
});
