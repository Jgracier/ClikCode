import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { CLIKCODE_LOCAL_NOT_INSTALLED, modelClientForSession } from '../agent/models/for-session';
import { aiGatewaySessionSend } from '../turn/drive';
import { readState } from './state/read';
import { writeState } from './state/write';
import type { HarnessSession, HarnessState } from './model';

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
    for (const name of ['native', 'login', 'model', 'effort', 'options']) {
      const availability = resolveSlashCommand(name)!.availability(local(), undefined);
      expect(availability.available, `/${name} offered on ClikCode Local`).toBe(false);
      expect(availability.reason).toContain('ClikCode Local');
    }
    // The Gateway's reasons are unchanged; its model is the user's to choose.
    expect(resolveSlashCommand('effort')!.availability(gateway(), undefined).reason).toContain('ClikDeploy Gateway');
    expect(resolveSlashCommand('model')!.availability(gateway(), undefined).available).toBe(true);
    for (const name of ['permissions', 'add-dir', 'init', 'review']) {
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

  it('says plainly that ClikCode Local cannot serve a turn in this build', async () => {
    await expect(modelClientForSession(local(), config)).rejects.toThrow(CLIKCODE_LOCAL_NOT_INSTALLED);
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
      const state = await readState();
      state.sessions.push({ ...local(), workspace: process.env.CLIKCODE_HOME! });
      await writeState(state);
      // Not "no account selected": that would mean it went down the vendor
      // harness path. Not a Gateway sign-in error either.
      await expect(aiGatewaySessionSend(config, 's1', 'hello')).rejects.toThrow(CLIKCODE_LOCAL_NOT_INSTALLED);
      const after = (await readState()).sessions.find((item) => item.id === 's1')!;
      expect(after.messages ?? []).toEqual([]);
      expect(after.pendingTurn).toBeUndefined();
      expect((await readState()).invocations).toEqual([]);
    });
  });
});
