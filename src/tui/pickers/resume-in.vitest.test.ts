import { describe, expect, it, vi } from 'vitest';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../../harness/definition';
import { accountHasUsage, resumeInCandidates, resumePromptForPendingTurn, sessionProviderHasUsage } from './resume-in';
import { INTERRUPTED_TURN_REQUEST } from '../../turn/failover-prompt.js';
import { createHandoffBranch } from '../../turn/handoff.js';

vi.mock('../../runtime/lazy-bridge.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../runtime/lazy-bridge.js')>(),
  isDirectModelProvider: (provider: string) => provider === 'anthropic',
}));

const harness = (command: string, provider: string, tier: number): AiLocalHarnessDefinition & { tier: number } => ({
  command, provider, displayName: command, surface: 'terminal', localAuth: ['vendor-cli'], binary: command, tier,
} as never);
const account = (id: string, provider: string, fields: Partial<AiHarnessAccount> = {}): AiHarnessAccount => ({
  id, provider, label: id, authKind: 'vendor-cli', models: [], status: 'ready', ...fields,
} as AiHarnessAccount);

describe('resume in', () => {
  it('continues an interrupted request carried in the branch instead of submitting it twice', () => {
    expect(resumePromptForPendingTurn({ prompt: 'finish the edit', response: 'changed a.ts', startedAt: '', updatedAt: '', outputStarted: true }, 'finish the edit'))
      .toBe(INTERRUPTED_TURN_REQUEST);
    expect(resumePromptForPendingTurn(undefined, 'finish the edit')).toBe('finish the edit');
    const branch = createHandoffBranch({
      source: {
        id: 'original', route: 'local', accountId: 'old', provider: 'old', model: null,
        effort: 'medium', permissionMode: 'ask', accountFailover: 'on-quota-exhausted',
        createdAt: '', updatedAt: '', status: 'active', messages: [{ role: 'user', content: 'earlier request' }],
        pendingTurn: { prompt: 'finish the edit', response: 'changed a.ts', startedAt: '', updatedAt: '', outputStarted: true },
      } as never,
      target: harness('codex', 'openai', 0), accountId: 'new', model: null,
      defaults: { effort: 'medium', permissionMode: 'ask', accountFailover: 'on-quota-exhausted' }, now: '',
    });
    expect(branch.messages?.map(({ content }) => content)).toEqual(['earlier request', 'finish the edit', 'changed a.ts']);
  });
  it('offers other harnesses with an account that has usage, best tier first', () => {
    const harnesses = [harness('claude', 'anthropic', 0), harness('codex', 'openai', 0), harness('gemini', 'google', 1), harness('hermes', 'nous', 2)];
    const accounts = [
      account('a1', 'anthropic', { quotaState: 'exhausted', quotaExhaustedAt: new Date().toISOString() }),
      account('g1', 'google'),
      account('o1', 'openai', { quotaState: 'exhausted', quotaExhaustedAt: new Date().toISOString() }),
      account('o2', 'openai'),
      account('n1', 'nous', { status: 'needs_login' }),
    ];
    const candidates = resumeInCandidates(harnesses, accounts, 'claude', (item) => (item as { tier: number }).tier);
    expect(candidates.map((candidate) => [candidate.harness.command, candidate.accounts.map((item) => item.id)])).toEqual([
      ['codex', ['o2']], ['gemini', ['g1']],
    ]);
  });

  it('counts only a ready, unspent, verified account as having usage', () => {
    expect(accountHasUsage(account('x', 'p'))).toBe(true);
    expect(accountHasUsage(account('x', 'p', { quotaState: 'exhausted', quotaExhaustedAt: new Date().toISOString() }))).toBe(false);
    expect(accountHasUsage(account('x', 'p', { status: 'needs_login' }))).toBe(false);
    expect(accountHasUsage(account('x', 'p', { verification: { reason: 'verify' } as never }))).toBe(false);
  });

  it('counts an account whose spent window has since reset as having usage', () => {
    const past = new Date(Date.now() - 3_600_000).toISOString();
    expect(accountHasUsage(account('x', 'p', {
      quotaState: 'exhausted', quotaExhaustedAt: new Date(Date.now() - 7_200_000).toISOString(),
      usage: { at: past, label: '5h 0% left', windows: [{ name: '5h', usedPct: 100, resetsAt: past }] } as never,
    }))).toBe(true);
  });

  it('is not offered while an account of the chat\'s own provider can take the turn', () => {
    const spent = account('a1', 'anthropic', { quotaState: 'exhausted', quotaExhaustedAt: new Date().toISOString() });
    const pending = account('a2', 'anthropic', { verification: { at: new Date().toISOString() } });
    expect(sessionProviderHasUsage([spent, pending, account('o1', 'openai')], 'anthropic')).toBe(false);
    expect(sessionProviderHasUsage([spent, pending, account('a3', 'anthropic')], 'anthropic')).toBe(true);
    expect(sessionProviderHasUsage([spent, account('a4', 'anthropic', { authKind: 'api-key' })], 'anthropic')).toBe(false);
    expect(sessionProviderHasUsage([account('aider-key', 'aider', { authKind: 'api-key' })], 'aider')).toBe(true);
  });
});
