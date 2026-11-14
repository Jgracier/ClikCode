import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessSession } from '../session/model.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';

/** What the vendor's own sign-in does in the profile it is run in. */
const vendor = vi.hoisted(() => ({ signIn: async (_environment: Readonly<Record<string, string>>): Promise<void> => { throw new Error('sign-in cancelled'); } }));
vi.mock('../harness/transport/native/login.js', () => ({
  loginNativeHarness: vi.fn(async (_harness: unknown, environment: Readonly<Record<string, string>>) => vendor.signIn(environment)),
}));

/** Codex's credential, as it writes it: who signed in is inside the id token. */
const codexAuth = (email: string, token: string): string =>
  JSON.stringify({ tokens: { id_token: `h.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.s`, access_token: token } });

const previousHome = process.env.CLIKCODE_HOME;
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'clikcode-login-'));
  process.env.CLIKCODE_HOME = root;
  vendor.signIn = async () => { throw new Error('sign-in cancelled'); };
});
afterEach(async () => {
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

/** An OpenAI account that was signed in once and no longer is: its profile
 * holds an expired credential nobody can read an identity from. */
async function signedOutAccount(options: { chats: boolean }): Promise<string> {
  const profile = join(root, 'profiles', 'codex', 'older');
  await mkdir(join(profile, 'sessions'), { recursive: true });
  await writeFile(join(profile, 'auth.json'), '{}');
  await writeFile(join(profile, 'sessions', 'thread.jsonl'), 'a vendor chat');
  const state = await readState();
  state.accounts.push({
    id: 'older', provider: 'openai', label: 'user@example.com', authKind: 'vendor-cli', models: [], status: 'needs_login',
    credentialRef: 'native:codex', nativeProfile: { env: 'CODEX_HOME', path: profile },
  });
  if (options.chats) {
    const now = new Date().toISOString();
    state.sessions.push({
      id: 's1', conversationId: 's1', route: 'local', accountId: 'older', provider: 'openai', model: null, nativeSessionId: 'thread',
      effort: 'medium', permissionMode: 'ask', createdAt: now, updatedAt: now, status: 'active',
    } as unknown as HarnessSession);
  }
  await writeState(state);
  return profile;
}

describe('account sign-in profiles', () => {
  it('adds no account, and leaves no profile, when the vendor\'s login ended without writing a credential', async () => {
    // Junie, stopped by a question nobody answered, exits 0 having written nothing.
    vendor.signIn = async () => undefined;
    const { aiAccountLogin } = await import('./account.js');
    await expect(aiAccountLogin('codex')).rejects.toThrow('ended without signing in');
    expect((await readState()).accounts.filter((account) => account.provider === 'openai')).toEqual([]);
    expect(await readdir(join(root, 'profiles', 'codex')).catch(() => [])).toEqual([]);
  });

  it('removes the profile a failed sign-in created', async () => {
    const { aiAccountLogin } = await import('./account.js');
    await expect(aiAccountLogin('codex')).rejects.toThrow('sign-in cancelled');
    expect(await readdir(join(root, 'profiles', 'codex')).catch(() => [])).toEqual([]);
  });

  it('re-authenticating an account with vendor chats signs in that account, in its own profile, and adds no second one', async () => {
    const profile = await signedOutAccount({ chats: true });
    vendor.signIn = async (environment) => { await writeFile(join(environment.CODEX_HOME!, 'auth.json'), codexAuth('user@example.com', 'fresh')); };
    const { aiAccountLogin } = await import('./account.js');
    expect(await aiAccountLogin('codex')).toBe('user@example.com');

    const accounts = (await readState()).accounts.filter((account) => account.provider === 'openai');
    expect(accounts.map((account) => [account.id, account.label, account.status])).toEqual([['older', 'user@example.com', 'ready']]);
    expect(accounts[0]!.nativeProfile?.path).toBe(profile);
    // The credential followed the account; its chats never moved; the profile the sign-in was made in is gone.
    expect(JSON.parse(await readFile(join(profile, 'auth.json'), 'utf8')).tokens.access_token).toBe('fresh');
    expect(await readFile(join(profile, 'sessions', 'thread.jsonl'), 'utf8')).toBe('a vendor chat');
    expect(await readdir(join(root, 'profiles', 'codex'))).toEqual(['older']);
  });

  it('re-authenticating an account with no chats moves it to the profile it signed in from', async () => {
    await signedOutAccount({ chats: false });
    vendor.signIn = async (environment) => { await writeFile(join(environment.CODEX_HOME!, 'auth.json'), codexAuth('user@example.com', 'fresh')); };
    const { aiAccountLogin } = await import('./account.js');
    await aiAccountLogin('codex');

    const accounts = (await readState()).accounts.filter((account) => account.provider === 'openai');
    expect(accounts.map((account) => [account.id, account.label, account.status])).toEqual([['older', 'user@example.com', 'ready']]);
    const profiles = await readdir(join(root, 'profiles', 'codex'));
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).not.toBe('older');
    expect(accounts[0]!.nativeProfile?.path).toBe(join(root, 'profiles', 'codex', profiles[0]!));
  });

  it('a sign-in as someone new is still a new account', async () => {
    await signedOutAccount({ chats: true });
    vendor.signIn = async (environment) => { await writeFile(join(environment.CODEX_HOME!, 'auth.json'), codexAuth('other@example.com', 'fresh')); };
    const { aiAccountLogin } = await import('./account.js');
    expect(await aiAccountLogin('codex')).toBe('other@example.com');
    const accounts = (await readState()).accounts.filter((account) => account.provider === 'openai');
    expect(accounts.map((account) => [account.label, account.status])).toEqual([['user@example.com', 'needs_login'], ['other@example.com', 'ready']]);
  });
});
