import { describe, expect, it } from 'vitest';
import type { AiHarnessAccount } from '../../harness/definition.js';
import type { HarnessSession, HarnessState } from '../../session/model.js';
import { usageReport } from './usage-report.js';

const NOW = Date.parse('2026-09-21T12:00:00');
const LATER = new Date(NOW + 3_600_000).toISOString();

function account(id: string, extra: Partial<AiHarnessAccount> = {}): AiHarnessAccount {
  return { id, provider: 'anthropic', label: id, authKind: 'vendor-cli', models: [], status: 'ready', credentialRef: id, ...extra };
}

function session(accountId: string): HarnessSession {
  return {
    id: 'chat', route: 'local', accountId, provider: 'anthropic', nativeHarness: 'claude', model: null,
    effort: 'medium', accountFailover: 'on-quota-exhausted', createdAt: '', updatedAt: '', status: 'active',
  };
}

function state(accounts: AiHarnessAccount[], invocations: HarnessState['invocations'] = []): HarnessState {
  return {
    version: 1, installationId: 't', localApiToken: 't', devicePrivateKeyPem: '', devicePublicKey: {},
    accounts, sessions: [], invocations, globalSettings: { effort: 'medium', permissionMode: 'ask', accountFailover: 'on-quota-exhausted' },
    providerSettings: {},
  };
}

describe('/usage report', () => {
  it('lists each account allowance and adds the provider and the conversation', () => {
    const full = account('full', {
      usage: { at: new Date(NOW).toISOString(), label: '5h 80% left', windows: [{ name: '5h', usedPct: 20, resetsAt: LATER }] } as AiHarnessAccount['usage'],
    });
    const empty = account('empty', {
      quotaState: 'exhausted',
      usage: { at: new Date(NOW).toISOString(), label: '5h 0% left', windows: [{ name: '5h', usedPct: 100, resetsAt: LATER }] } as AiHarnessAccount['usage'],
    });
    const invocations: HarnessState['invocations'] = [
      { id: 'a', accountId: 'full', provider: 'anthropic', sessionId: 'chat', at: new Date(NOW).toISOString(), inputTokens: 100, outputTokens: 40, cacheReadTokens: 10, costUsd: 0.01, latencyMs: 1 },
      { id: 'b', accountId: 'empty', provider: 'anthropic', sessionId: 'other', at: new Date(NOW).toISOString(), inputTokens: 50, outputTokens: 10, latencyMs: 1 },
    ];
    const report = usageReport(state([full, empty, account('other', { provider: 'openai' })], invocations), session('full'), { now: NOW, providerName: 'Claude Code' });
    expect(report.text).toContain('Claude Code');
    expect(report.text).toContain('full · current');
    expect(report.text).toContain('5h 80% left');
    expect(report.text).toContain('5h 0% left');
    expect(report.text).toContain('Resets ');
    expect(report.text).not.toContain('other');
    expect(report.totals.accounts).toBe(2);
    expect(report.totals.inputTokens).toBe(150);
    expect(report.totals.outputTokens).toBe(50);
    expect(report.totals.costUsd).toBeCloseTo(0.01);
    expect(report.text).toContain('This conversation');
    expect(report.text).toContain('$0.0100');
  });

  it('follows the harness the chat is on, even when the session has no provider id', () => {
    const grok = account('grok-login', { provider: 'xai', label: 'grok-login' });
    const claude = account('claude-login');
    const chat = { ...session('grok-login'), provider: null, nativeHarness: 'grok' };
    const report = usageReport(state([grok, claude]), chat, { now: NOW, providerName: 'Grok Build', providerId: 'xai' });
    expect(report.text).toContain('Grok Build');
    expect(report.text).toContain('grok-login · current');
    expect(report.text).not.toContain('claude-login');
    expect(report.totals.accounts).toBe(1);
  });
});
