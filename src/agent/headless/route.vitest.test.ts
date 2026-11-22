import { describe, expect, it, vi } from 'vitest';
import * as routing from '../../turn/account-routing.js';
import { agentRoute, headlessAccount } from './route.js';

vi.mock('../../turn/account-routing.js', async original => {
  const actual = await original<typeof import('../../turn/account-routing.js')>();
  return { ...actual, nextUsableFailoverAccount: vi.fn(actual.nextUsableFailoverAccount) };
});

const M = 'claude-sonnet-5-5';

describe('the account a short headless turn runs on', () => {
  const account = (provider: string, env: string, quotaState: 'available' | 'exhausted' = 'available'): import('../../harness/definition.js').AiHarnessAccount => ({ id: provider, provider, label: provider, authKind: 'vendor-cli', credentialRef: provider, status: 'ready', quotaState, ...(quotaState === 'exhausted' ? { quotaExhaustedAt: new Date().toISOString(), quotaRetryAt: new Date(Date.now() + 3_600_000).toISOString() } : {}), models: [], nativeProfile: { env, path: `/profiles/${provider}` } });
  it('uses the saved Codex profile when Claude is spent', () => {
    const codex = account('openai', 'CODEX_HOME');
    expect(headlessAccount([account('anthropic', 'CLAUDE_CONFIG_DIR', 'exhausted'), codex])?.id).toBe('openai');
  });
  it('does not treat an API key or a signed-out profile as a native fallback', () => {
    const signedOut = { ...account('openai', 'CODEX_HOME'), status: 'needs_login' as const };
    const api = { ...account('anthropic', 'CLAUDE_CONFIG_DIR'), authKind: 'api-key' as const };
    expect(headlessAccount([signedOut, api])).toBeUndefined();
  });
});

describe('the route a headless agent runs on', () => {
  const account = (id: string, provider: string, env: string, quotaState: 'available' | 'exhausted' = 'available'): import('../../harness/definition.js').AiHarnessAccount => ({ id, provider, label: `${id}@example.com`, authKind: 'vendor-cli', credentialRef: id, status: 'ready', quotaState, ...(quotaState === 'exhausted' ? { quotaExhaustedAt: new Date().toISOString(), quotaRetryAt: new Date(Date.now() + 3_600_000).toISOString() } : {}), nativeProfile: { env, path: `/tmp/${id}` } } as never);
  const chat = (updatedAt: string, nativeHarness: string, accountId: string, model?: string) => ({ id: updatedAt, route: 'local', nativeHarness, accountId, updatedAt, ...(model ? { model } : {}) }) as never;
  const accounts = [account('claude-a', 'anthropic', 'CLAUDE_CONFIG_DIR'), account('codex-b', 'openai', 'CODEX_HOME')];

  it('uses the initiating conversation even when another window has newer activity', () => {
    const sessions = [chat('2026-11-18T10:00:00Z', 'codex', 'codex-b', 'gpt-test'), chat('2026-11-18T12:00:00Z', 'claude', 'claude-a', 'opus')];
    expect(agentRoute({ accounts, sessions }, { sessionId: '2026-11-18T10:00:00Z', claudeModel: M })).toMatchObject({ harness: 'codex', model: 'gpt-test', account: { id: 'codex-b' } });
  });
  it('does not substitute a different conversation when the bound one is missing', () => {
    expect(agentRoute({ accounts, sessions: [chat('2026-11-18T12:00:00Z', 'claude', 'claude-a')] }, { sessionId: 'missing', claudeModel: M })).toEqual({ error: expect.stringContaining('no other chat will be used') });
  });
  it('does not substitute a different harness when the bound chat cannot run headless', () => {
    const sessions = [chat('2026-11-18T10:00:00Z', 'codex', 'codex-b'), chat('2026-11-18T12:00:00Z', 'copilot', 'claude-a')];
    expect(agentRoute({ accounts, sessions }, { sessionId: '2026-11-18T12:00:00Z', claudeModel: M })).toEqual({ error: expect.stringContaining('bound chat runs on copilot') });
  });
  it('is the harness, account and model of the most recent chat', () => {
    const route = agentRoute({ accounts, sessions: [chat('2026-11-18T10:00:00Z', 'codex', 'codex-b'), chat('2026-11-18T12:00:00Z', 'claude', 'claude-a', 'opus')] }, { claudeModel: M });
    expect(route).toMatchObject({ harness: 'claude', account: { id: 'claude-a' }, model: 'claude-sonnet-5-5' });
  });
  it('moves to another signed-in account of the same vendor when the chat\'s has no usage left, as a chat turn does', () => {
    const spent = [account('codex-a', 'openai', 'CODEX_HOME', 'exhausted'), account('claude-a', 'anthropic', 'CLAUDE_CONFIG_DIR'), account('codex-b', 'openai', 'CODEX_HOME')];
    const route = agentRoute({ accounts: spent, sessions: [chat('2026-11-18T12:00:00Z', 'codex', 'codex-a', 'gpt-test')] }, { claudeModel: M });
    expect(route).toMatchObject({ harness: 'codex', account: { id: 'codex-b' }, model: 'gpt-test', movedFrom: 'codex-a@example.com' });
  });
  it('never moves to another vendor, and says the usage is out when no account of the chat\'s vendor is left', () => {
    const spent = [account('claude-a', 'anthropic', 'CLAUDE_CONFIG_DIR', 'exhausted'), account('codex-b', 'openai', 'CODEX_HOME')];
    const route = agentRoute({ accounts: spent, sessions: [chat('2026-11-18T12:00:00Z', 'claude', 'claude-a')] }, { claudeModel: M });
    expect(route).toEqual({ error: expect.stringContaining('has no usage left now') });
  });
  it('does not go back to an account this hand-off already tried', () => {
    const two = [account('codex-a', 'openai', 'CODEX_HOME'), account('codex-b', 'openai', 'CODEX_HOME')];
    const sessions = [chat('2026-11-18T12:00:00Z', 'codex', 'codex-a')];
    const now = Date.now();
    expect(agentRoute({ accounts: two, sessions }, { now, attempted: new Map([['codex-a', now]]), claudeModel: M })).toMatchObject({ account: { id: 'codex-b' } });
    expect(agentRoute({ accounts: two, sessions }, { now, attempted: new Map([['codex-a', now], ['codex-b', now]]), claudeModel: M })).toEqual({ error: expect.stringContaining('has no usage left now') });
  });
  it('says so when the chat runs on a harness a headless agent cannot use', () => {
    expect(agentRoute({ accounts, sessions: [chat('2026-11-18T12:00:00Z', 'opencode', 'claude-a')] }, { claudeModel: M })).toEqual({ error: expect.stringContaining('run on opencode') });
  });
  it('skips a newer chat on a harness that cannot run headless for the most recent Claude Code or Codex chat', () => {
    const route = agentRoute({ accounts, sessions: [chat('2026-11-18T10:00:00Z', 'claude', 'claude-a', 'opus'), chat('2026-11-18T12:00:00Z', 'copilot', 'claude-a')] }, { claudeModel: M });
    expect(route).toMatchObject({ harness: 'claude', account: { id: 'claude-a' }, model: 'claude-sonnet-5-5' });
  });
  it('judges failover usage by the model the run uses, not the chat\'s', () => {
    const spent = [account('claude-a', 'anthropic', 'CLAUDE_CONFIG_DIR', 'exhausted'), account('claude-b', 'anthropic', 'CLAUDE_CONFIG_DIR')];
    const spy = vi.mocked(routing.nextUsableFailoverAccount);
    spy.mockClear();
    agentRoute({ accounts: spent, sessions: [chat('2026-11-18T12:00:00Z', 'claude', 'claude-a', 'opus')] }, { claudeModel: M });
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0]![5]).toBe(M);
  });
});
