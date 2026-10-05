/** A sign-in opens only when the user asked for the provider: picked it, or
 * sent a turn on it. Choosing one without asking (opening ClikCode) marks an
 * account that needs one, and its first turn signs in. CLIKCODE_HOME is
 * throwaway; the vendor's install, status check and login are stubbed. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessSession } from '../../session/model.js';
import { readState } from '../../session/state/read.js';
import { writeState } from '../../session/state/write.js';

const vendor = vi.hoisted(() => ({ logins: 0, installs: 0 }));
vi.mock('../../harness/transport/native/inspect.js', async (original) => ({
  ...await original<object>(),
  ensureNativeHarness: async () => { vendor.installs += 1; return false; },
}));
vi.mock('../../harness/transport/native/login.js', () => ({ loginNativeHarness: async () => { vendor.logins += 1; } }));
vi.mock('../account.js', async (original) => ({
  ...await original<object>(),
  harnessNeedsLogin: async () => true,
  syncAccountIdentityAfterLogin: async (_harness: unknown, account: { status: string }) => { account.status = 'ready'; return account; },
}));
vi.mock('../../harness/accounts/labels.js', async (original) => ({ ...await original<object>(), deriveAccountLabel: async () => undefined }));
vi.mock('../../harness/accounts/model-catalog.js', async (original) => ({ ...await original<object>(), resolveNativeModel: async () => 'gpt-5' }));
const { aiHarnessSelect } = await import('./harness.js');

const saved = process.env.CLIKCODE_HOME;
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cc-select-'));
  process.env.CLIKCODE_HOME = root;
  vendor.logins = 0;
  vendor.installs = 0;
  const state = await readState();
  const now = new Date().toISOString();
  state.sessions.push({
    id: 's1', conversationId: 's1', route: 'local', accountId: null, provider: null, model: null,
    effort: 'medium', permissionMode: 'ask', accountFailover: 'never', createdAt: now, updatedAt: now, status: 'active',
  } as unknown as HarnessSession);
  await writeState(state);
});
afterEach(async () => {
  if (saved === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = saved;
  await rm(root, { recursive: true, force: true });
});

const signer = () => ({ activity: vi.fn(), signInScreen: undefined });

describe('choosing a provider', () => {
  it('without the user asking: no sign-in, the account waits for its first turn', async () => {
    await aiHarnessSelect('codex', 's1', { emit: false, signIn: false });
    const state = await readState();
    expect(vendor.logins).toBe(0);
    const account = state.accounts.find((item) => item.id === state.sessions[0]!.accountId);
    expect(account?.status).toBe('needs_login');
  });

  it('picked by the user: installed if needed, then signed in at once', async () => {
    await aiHarnessSelect('codex', 's1', { emit: false, prompter: signer() as never });
    const state = await readState();
    expect(vendor.installs).toBe(1);
    expect(vendor.logins).toBe(1);
    expect(state.accounts.find((item) => item.id === state.sessions[0]!.accountId)?.status).toBe('ready');
  });
});
