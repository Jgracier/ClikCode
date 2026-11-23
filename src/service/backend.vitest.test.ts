/** The service's real backend, with only the vendor faked: its login (what
 * the codex CLI does on the sign-in screen it is given) and the turn's
 * vendor run. Accounts, profiles and the sign-in bookkeeping are ClikCode's own. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Conf from 'conf';
import type { SignInScreen } from '../gateway/login/vendor-sign-in.js';
import type { TurnRunOptions } from '../turn/session-turn.js';
import type { TurnEvent } from './turns.js';
import type { LoginView } from './logins.js';

const vendor = vi.hoisted(() => ({
  /** The vendor's login, run in the profile `environment` names, on `screen`. */
  login: async (_environment: Readonly<Record<string, string>>, _screen: SignInScreen | undefined): Promise<void> => undefined,
  /** The vendor's turn. */
  turn: async (_sessionId: string, _prompt: string, _run: TurnRunOptions): Promise<void> => undefined,
}));

vi.mock('../harness/transport/native/login.js', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const screens = new AsyncLocalStorage<SignInScreen>();
  return {
    withSignInScreen: <T>(screen: SignInScreen, work: () => Promise<T>) => screens.run(screen, work),
    loginNativeHarness: vi.fn(async (_harness: unknown, environment: Readonly<Record<string, string>>) => vendor.login(environment, screens.getStore())),
  };
});
vi.mock('../harness/transport/native/inspect.js', () => ({
  inspectNativeHarnessForPicker: async () => ({ installed: true }),
  ensureNativeHarness: async () => false,
}));
vi.mock('../turn/session-turn.js', () => ({
  runSessionTurn: vi.fn(async (_config: unknown, id: string, prompt: string, _signal: AbortSignal, run: TurnRunOptions) => vendor.turn(id, prompt, run)),
}));

/** Codex's credential as it writes it: who signed in is inside the id token. */
const codexAuth = (email: string): string =>
  JSON.stringify({ tokens: { id_token: `h.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.s`, access_token: 'token-value' } });

const previousHome = process.env.CLIKCODE_HOME;
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'clikcode-service-'));
  process.env.CLIKCODE_HOME = root;
});
afterEach(async () => {
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

async function settle(read: () => LoginView, done: (view: LoginView) => boolean): Promise<LoginView> {
  for (let tries = 0; tries < 300; tries += 1) {
    const view = read();
    if (done(view)) return view;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`stuck at ${JSON.stringify(read())}`);
}

describe('the machine backend', () => {
  it('signs in a codex account headlessly through ClikCode\'s own login, lists it, and reconnects it in place', async () => {
    vendor.login = async (environment, screen) => {
      screen!.show({ url: 'https://auth.openai.com/codex/device', code: 'WXYZ-1234' });
      const confirm = await screen!.ask('Press Enter once approved', false);
      expect(confirm).toBe('');
      await mkdir(environment.CODEX_HOME!, { recursive: true });
      await writeFile(join(environment.CODEX_HOME!, 'auth.json'), codexAuth('person@example.com'));
    };
    const { machineBackend } = await import('./backend.js');
    const backend = machineBackend({} as Conf);
    expect((await backend.providers()).find((provider) => provider.harness === 'codex')).toMatchObject({ provider: 'openai', loginKinds: expect.arrayContaining(['device']), installed: true });

    const login = backend.logins.start({ provider: 'openai' });
    const waiting = await settle(() => login.view(), (view) => view.state === 'awaiting-input');
    expect(waiting).toMatchObject({ verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'WXYZ-1234', prompt: 'Press Enter once approved' });
    login.input('');
    const connected = await settle(() => login.view(), (view) => view.state !== 'awaiting-input' && view.state !== 'awaiting-user' && view.state !== 'starting');
    expect(connected.state).toBe('connected');
    const accounts = await backend.accounts();
    expect(accounts).toEqual([expect.objectContaining({ id: connected.accountId, provider: 'openai', harness: 'codex', label: 'person@example.com', status: 'connected' })]);

    // Reconnect: the same person lands on the same account, never a second one.
    const again = backend.logins.start({ provider: 'codex', accountId: connected.accountId! });
    await settle(() => again.view(), (view) => view.state === 'awaiting-input');
    again.input('');
    expect(await settle(() => again.view(), (view) => view.state === 'connected')).toMatchObject({ accountId: connected.accountId });
    expect((await backend.accounts()).map((account) => account.id)).toEqual([connected.accountId]);

    // Removed: gone from the list, its profile with it.
    expect(await backend.removeAccount(connected.accountId!)).toBe(true);
    expect(await backend.accounts()).toEqual([]);
    expect(await backend.removeAccount(connected.accountId!)).toBe(false);
  });

  it('runs a turn pinned to its account, in a conversation it does not keep, and says a refusal\'s reason', async () => {
    const { readState } = await import('../session/state/read.js');
    const { writeState } = await import('../session/state/write.js');
    const profile = join(root, 'profiles', 'codex', 'acct');
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, 'auth.json'), codexAuth('person@example.com'));
    const state = await readState();
    state.accounts.push({ id: 'acct', provider: 'openai', label: 'person@example.com', authKind: 'vendor-cli', models: [], status: 'ready', credentialRef: 'native:codex', nativeProfile: { env: 'CODEX_HOME', path: profile } });
    await writeState(state);
    const { machineBackend } = await import('./backend.js');
    const backend = machineBackend({} as Conf);

    const seen: { session?: unknown; prompt?: string; run?: TurnRunOptions } = {};
    vendor.turn = async (id, prompt, run) => {
      seen.session = (await readState({ transcripts: [id] })).sessions.find((item) => item.id === id);
      seen.prompt = prompt;
      seen.run = run;
      run.prompter!.response('pong');
      run.prompter!.setTurnUsage({ input: 5, output: 1, stopReason: 'completed' });
    };
    const events: TurnEvent[] = [];
    await backend.runTurn({ accountId: 'acct', model: 'gpt-5', system: 'Be brief.', messages: [{ role: 'user', content: 'ping' }] }, (event) => events.push(event), new AbortController().signal);
    expect(events).toEqual([{ type: 'text', text: 'pong' }, { type: 'usage', inputTokens: 5, outputTokens: 1 }, { type: 'done', stopReason: 'completed' }]);
    expect(seen.session).toMatchObject({ accountId: 'acct', nativeHarness: 'codex', route: 'local', model: 'gpt-5', permissionMode: 'bypass' });
    expect(seen.run?.pinnedAccount).toBe(true);
    expect(seen.prompt).toContain('Be brief.');
    // Not kept: the caller holds its own conversation.
    expect((await readState()).sessions).toEqual([]);

    const resets = new Date(Date.now() + 3_600_000).toISOString();
    vendor.turn = async () => {
      const now = await readState();
      now.accounts[0]!.quotaState = 'exhausted';
      now.accounts[0]!.quotaExhaustedAt = new Date().toISOString();
      now.accounts[0]!.quotaRetryAt = resets;
      await writeState(now);
      throw new Error('You\'ve hit your usage limit. Try again later.');
    };
    const refused: TurnEvent[] = [];
    await backend.runTurn({ accountId: 'acct', messages: [{ role: 'user', content: 'ping' }] }, (event) => refused.push(event), new AbortController().signal);
    expect(refused).toEqual([{ type: 'error', reason: 'limited', message: expect.stringContaining('usage limit'), retryAfterSec: expect.any(Number) }]);
    expect((refused[0] as { retryAfterSec: number }).retryAfterSec).toBeGreaterThan(3_500);

    vendor.turn = (_id, _prompt, run) => new Promise((_resolve, reject) => { void run; setTimeout(() => reject(new Error('Stopped')), 200); });
    const slow: TurnEvent[] = [];
    await backend.runTurn({ accountId: 'acct', messages: [{ role: 'user', content: 'ping' }], timeoutMs: 20 }, (event) => slow.push(event), new AbortController().signal);
    expect(slow).toEqual([{ type: 'error', reason: 'timeout', message: expect.any(String) }]);
  });

  it('refuses a turn on an account that needs a sign-in without running it', async () => {
    const { readState } = await import('../session/state/read.js');
    const { writeState } = await import('../session/state/write.js');
    const state = await readState();
    state.accounts.push({ id: 'out', provider: 'openai', label: 'gone@example.com', authKind: 'vendor-cli', models: [], status: 'needs_login', credentialRef: 'native:codex' });
    await writeState(state);
    vendor.turn = async () => { throw new Error('must not run'); };
    const { machineBackend } = await import('./backend.js');
    const events: TurnEvent[] = [];
    await machineBackend({} as Conf).runTurn({ accountId: 'out', messages: [{ role: 'user', content: 'x' }] }, (event) => events.push(event), new AbortController().signal);
    expect(events).toEqual([{ type: 'error', reason: 'needs-login', message: expect.any(String) }]);
    expect((await machineBackend({} as Conf).accounts())[0]).toMatchObject({ id: 'out', status: 'needs-login' });
  });
});
