import { describe, expect, it } from 'vitest';
import type { AiHarnessAccount } from '../../harness/definition';
import type { HarnessState } from '../../session/model';
import { signedInAccountId } from './preferred-account';

function account(id: string, extra: Partial<AiHarnessAccount> = {}): AiHarnessAccount {
  return { id, provider: 'antigravity', label: id, authKind: 'vendor-cli', models: [], status: 'ready', credentialRef: `native:${id}`, ...extra };
}
function state(accounts: AiHarnessAccount[]): HarnessState {
  return { accounts, sessions: [] } as unknown as HarnessState;
}

describe('the account a provider switch lands on', () => {
  it('takes a usable account when there is one', () => {
    const accounts = [account('spent', { quotaState: 'exhausted' }), account('fresh', { quotaState: 'available' })];
    expect(signedInAccountId(state(accounts), 'antigravity')).toBe('fresh');
  });

  it('still picks an account when every one is spent or awaiting verification, so no sign-in is asked for', () => {
    const accounts = [
      account('spent', { quotaState: 'exhausted' }),
      account('verify', { quotaState: 'available', verification: { at: '2026-09-26T00:00:00Z' } }),
    ];
    // Quota left, even pending verification, ranks ahead of quota spent.
    expect(signedInAccountId(state(accounts), 'antigravity')).toBe('verify');
    expect(signedInAccountId(state([account('only', { quotaState: 'exhausted' })]), 'antigravity')).toBe('only');
  });

  it("keeps the session's own account when it is signed in", () => {
    const accounts = [account('a', { quotaState: 'exhausted' }), account('b', { quotaState: 'exhausted' })];
    expect(signedInAccountId(state(accounts), 'antigravity', 'b')).toBe('b');
  });

  it('is null only when the provider has no signed-in account -- the one case to sign in', () => {
    expect(signedInAccountId(state([account('out', { status: 'needs_login' })]), 'antigravity')).toBeNull();
    expect(signedInAccountId(state([]), 'antigravity')).toBeNull();
    expect(signedInAccountId(state([account('other', { provider: 'xai' })]), 'antigravity')).toBeNull();
  });
});
