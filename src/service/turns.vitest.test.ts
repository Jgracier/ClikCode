import { describe, expect, it, vi } from 'vitest';
import { classifyTurnFailure } from '../turn/account-evidence.js';
import { turnAccounts } from '../turn/account-routing.js';
import { usageExhaustedMessage } from '../turn/usage-exhausted.js';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessSession, HarnessState } from '../session/model.js';
import { EventObserver, errorReason, parseTurnRequest, retryAfterSeconds, safeMessage, turnPrompt, type TurnEvent } from './turns.js';
import { loginKinds, serviceAccountView, serviceProviders, usageSummary } from './accounts.js';

vi.mock('../session/state/index-file.js', async (original) => ({ ...await original<object>(), loadIndex: async () => undefined }));

const reasonOf = (error: unknown, timedOut = false) => errorReason(error, classifyTurnFailure(error), { timedOut });

describe('error reasons', () => {
  it('maps ClikCode\'s classification of real vendor refusals onto the API reasons', () => {
    expect(reasonOf(new Error('You\'ve hit your session limit · resets 3:50pm'))).toBe('limited');
    expect(reasonOf(Object.assign(new Error('Too many requests'), { statusCode: 429 }))).toBe('limited');
    expect(reasonOf(new Error(usageExhaustedMessage()))).toBe('limited');
    expect(reasonOf(new Error('Invalid API key · Please run /login'))).toBe('needs-login');
    expect(reasonOf(Object.assign(new Error('OAuth token has been revoked'), { statusCode: 401 }))).toBe('revoked');
    expect(reasonOf(new Error('Eligibility check failed: Your current account is not eligible for Antigravity. Verify your account to continue.'))).toBe('revoked');
    expect(reasonOf(new Error('The model is not supported when using Codex with a ChatGPT account.'))).toBe('not-entitled');
    expect(reasonOf(new Error('model "gpt-9" is not available through local account "me"'))).toBe('model-unavailable');
    expect(reasonOf(new Error('invalid model selection (--model "x")'))).toBe('model-unavailable');
    expect(reasonOf(new Error('spawn claude ENOENT'))).toBe('crashed');
    expect(reasonOf(new Error('Stopped'), true)).toBe('timeout');
  });

  it('says when a limited account is back, and hides credentials in messages', () => {
    expect(retryAfterSeconds(new Date(Date.now() + 90_000).toISOString())).toBeGreaterThanOrEqual(89);
    expect(retryAfterSeconds(new Date(Date.now() - 1).toISOString())).toBeUndefined();
    expect(retryAfterSeconds(undefined)).toBeUndefined();
    expect(safeMessage(new Error('failed with Bearer abcdefghijklmnopqrstuvwxyz'))).not.toContain('abcdefghijklmnop');
  });
});

describe('a pinned turn', () => {
  it('ends on its own account\'s refusal instead of moving to another', async () => {
    const own = { id: 'own', provider: 'anthropic', label: 'Own', status: 'ready', models: [], authKind: 'vendor-cli', credentialRef: 'native:claude' } as AiHarnessAccount;
    const other = { ...own, id: 'other', label: 'Other' } as AiHarnessAccount;
    const make = (pinned: boolean) => {
      const state = { accounts: [own, other], sessions: [], invocations: [] } as unknown as HarnessState;
      const session = { id: 'chat', accountId: own.id } as HarnessSession;
      return turnAccounts({ state, session, matchesBackend: () => true, persist: async () => undefined, current: () => own, adopt: () => undefined, ...(pinned ? { pinned: true } : {}) });
    };
    const refusal = new Error('You\'ve hit your session limit · resets 3:50pm');
    await expect(make(false).after(refusal, 'quota-exhausted')).resolves.toMatchObject({ id: 'other' });
    await expect(make(true).after(refusal, 'quota-exhausted')).rejects.toThrow(usageExhaustedMessage());
    const auth = new Error('Invalid API key · Please run /login');
    await expect(make(true).after(auth, 'authentication-required')).rejects.toBe(auth);
  });
});

describe('the event stream', () => {
  it('sends appended text, the rest of a replaced answer, each tool status once, then usage and done', () => {
    const events: TurnEvent[] = [];
    const observer = new EventObserver((event) => events.push(event));
    observer.response('Hel');
    observer.response('lo', 'append');
    observer.response('Hello world', 'replace');
    observer.response('Bye', 'replace');
    observer.activityEvent({ kind: 'tool-start', label: 'Read file', id: 'c1', call: { name: 'read' } });
    observer.activityEvent({ kind: 'tool-start', label: 'Read file', id: 'c1', call: { name: 'read' } });
    observer.activityEvent({ kind: 'tool-done', label: 'Read file', id: 'c1', call: { name: 'read' } });
    observer.activityEvent({ kind: 'thinking', label: 'Thinking' });
    observer.setTurnUsage({ input: 10, output: 4, cacheRead: 100, costUsd: 0.01, stopReason: 'max-tokens' });
    observer.finish();
    expect(events).toEqual([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
      { type: 'text', text: ' world' },
      { type: 'text', text: 'Bye', replace: true },
      { type: 'tool', name: 'read', status: 'started' },
      { type: 'tool', name: 'read', status: 'done' },
      { type: 'usage', inputTokens: 10, outputTokens: 4, costUsd: 0.01, cacheReadTokens: 100 },
      { type: 'done', stopReason: 'max-tokens' },
    ]);
    expect(observer.text).toBe('Bye');
  });

  it('refuses a sign-in mid-turn and allows what bypass would', async () => {
    const observer = new EventObserver(() => undefined);
    await expect(observer.signIn()).rejects.toMatchObject({ outcome: 'unavailable' });
    await expect(observer.approval()).resolves.toBe(true);
  });
});

describe('a turn request', () => {
  it('is read from its body', () => {
    expect(parseTurnRequest({ accountId: 'a', messages: [{ role: 'user', content: 'hi' }], timeoutMs: 10 ** 9, maxTurns: 3.7 }))
      .toEqual({ accountId: 'a', messages: [{ role: 'user', content: 'hi' }], timeoutMs: 3_600_000, maxTurns: 3 });
    expect(parseTurnRequest({ messages: [] })).toEqual({ error: 'accountId is required' });
    expect(parseTurnRequest({ accountId: 'a', messages: [{ role: 'user', content: 1 }] })).toHaveProperty('error');
    expect(parseTurnRequest({ accountId: 'a', messages: [{ role: 'user', content: 'x' }], mcp: { url: 'https://x', headers: { a: 1 } } })).toHaveProperty('error');
  });

  it('is one prompt: instructions, the earlier conversation, then the user\'s message', () => {
    expect(turnPrompt({ messages: [{ role: 'user', content: 'hi' }] })).toBe('hi');
    const prompt = turnPrompt({ system: 'Be brief.', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] });
    expect(prompt).toBe('<instructions>\nBe brief.\n</instructions>\n\n<conversation>\n<user>\na\n</user>\n<assistant>\nb\n</assistant>\n</conversation>\n\nc');
  });
});

describe('accounts and providers', () => {
  const account = { id: 'id1', provider: 'anthropic', label: 'me@x.com', authKind: 'vendor-cli', models: ['opus'], status: 'ready', credentialRef: 'native:claude', usageCheckedAt: '2026-11-23T00:00:00.000Z' } as AiHarnessAccount;
  const facts = { harness: 'claude', signedOutOnDisk: false, canTakeTurn: true };

  it('says each account\'s status', () => {
    expect(serviceAccountView(account, facts)).toEqual({ id: 'id1', provider: 'anthropic', harness: 'claude', label: 'me@x.com', status: 'connected', checkedAt: '2026-11-23T00:00:00.000Z', models: ['opus'] });
    expect(serviceAccountView({ ...account, status: 'needs_login' }, facts).status).toBe('needs-login');
    expect(serviceAccountView(account, { ...facts, signedOutOnDisk: true }).status).toBe('needs-login');
    expect(serviceAccountView({ ...account, verification: { at: 'x' } }, facts).status).toBe('revoked');
    const limited = serviceAccountView(account, { ...facts, canTakeTurn: false, backAt: '2026-11-24T00:00:00.000Z', windows: [{ name: '5h', usedPct: 100 }, { name: 'weekly', usedPct: 40 }] });
    expect(limited).toMatchObject({ status: 'limited', usage: { window: '5h', remainingPct: 0, resetsAt: '2026-11-24T00:00:00.000Z' } });
    expect(serviceAccountView(account, { ...facts, harness: undefined }).status).toBe('unknown');
    expect(usageSummary(undefined)).toBeUndefined();
  });

  it('lists the providers that sign in headlessly, with how', () => {
    expect(loginKinds({ loginArgv: ['login'], loginRemoteArgv: ['login', '--device-auth'], localAuth: ['vendor-cli'] })).toEqual(['device']);
    expect(loginKinds({ loginArgv: ['auth', 'login'], localAuth: ['api-key', 'vendor-cli'], authEnv: ['ANTHROPIC_API_KEY'] })).toEqual(['url-code', 'api-key']);
    const harnesses = [
      { command: 'claude', provider: 'anthropic', displayName: 'Claude Code', loginArgv: ['auth', 'login'], localAuth: ['vendor-cli'] },
      { command: 'nologin', provider: 'x', displayName: 'X', localAuth: ['vendor-cli'] },
    ] as never[];
    expect(serviceProviders(harnesses, () => true, (harness: { command: string }) => harness.command === 'claude'))
      .toEqual([{ provider: 'anthropic', harness: 'claude', name: 'Claude Code', loginKinds: ['url-code'], installed: true }]);
  });
});
