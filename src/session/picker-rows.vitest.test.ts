/** The pickers' rows as data: one rule for the terminal and the editor. Each
 * test below is a place where the copies used to disagree, and says which
 * rule won. The vendor is never asked: PATH, credentials on disk, effort
 * discovery and learned usage are stubbed. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Conf from 'conf';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessSession, HarnessState } from './model.js';
import { localHarnessForCommand } from '../runtime/lazy-bridge.js';
import { accountUsageText, type UsageReading } from '../harness/accounts/usage-reading.js';

const vendor = vi.hoisted(() => ({
  installed: new Set<string>(),
  evidence: new Set<string>(),
  efforts: undefined as string[] | undefined,
  learned: undefined as UsageReading | undefined,
}));
vi.mock('../harness/transport/native/inspect.js', async (original) => ({
  ...await original<object>(),
  inspectNativeHarnessForPicker: async (spec: { command: string }) => ({ installed: vendor.installed.has(spec.command) }),
}));
vi.mock('../harness/accounts/auth-files.js', async (original) => ({
  ...await original<object>(),
  authEvidencePresent: async (spec: { binary?: string }) => vendor.evidence.has(spec.binary ?? ''),
}));
vi.mock('../harness/accounts/effort-choices.js', async (original) => ({
  ...await original<object>(),
  effortChoicesFor: async () => {
    if (!vendor.efforts) throw new Error('help would not run');
    return { values: vendor.efforts, source: 'vendor-help' };
  },
}));
vi.mock('../harness/accounts/learned-usage.js', async (original) => ({
  ...await original<object>(),
  learnedReading: () => vendor.learned,
}));
const { accountRow, accountUsage, effortChoices, harnessSignedIn, providerRows } = await import('./picker-rows.js');

const NOW = Date.parse('2026-10-06T12:00:00Z');
const LATER = new Date(NOW + 3_600_000).toISOString();
const EARLIER = new Date(NOW - 3_600_000).toISOString();

function account(extra: Partial<AiHarnessAccount> = {}): AiHarnessAccount {
  return { id: 'a1', provider: 'openai', label: 'me@example.com', authKind: 'vendor-cli', models: [], status: 'ready', credentialRef: 'native:codex', ...extra };
}

function session(extra: Partial<HarnessSession> = {}): HarnessSession {
  return {
    id: 's1', route: 'local', accountId: 'a1', provider: 'openai', nativeHarness: 'codex', model: null,
    effort: 'medium', createdAt: '', updatedAt: '', status: 'active', ...extra,
  };
}

function state(accounts: AiHarnessAccount[] = []): HarnessState {
  return {
    version: 1, installationId: 't', localApiToken: 't', devicePrivateKeyPem: '', devicePublicKey: {},
    accounts, sessions: [], invocations: [], globalSettings: { effort: 'medium', permissionMode: 'ask' },
    providerSettings: {},
  };
}

const codex = localHarnessForCommand('codex')!;

beforeEach(() => {
  vendor.installed = new Set();
  vendor.evidence = new Set();
  vendor.efforts = undefined;
  vendor.learned = undefined;
});

describe('signed in', () => {
  // Was three rules: the editor (ready account or credential), new-chat
  // auto-select (ready AND not out of usage, or credential) and the terminal
  // picker (not computed). Running out is not signing out.
  it('counts a ready account that is out of usage', async () => {
    const spent = account({ usage: { at: new Date(NOW).toISOString(), label: '5h 0% left', windows: [{ name: '5h', usedPct: 100, resetsAt: LATER }] } as AiHarnessAccount['usage'] });
    expect(await harnessSignedIn(codex, [spent], false)).toBe(true);
  });

  it('counts a credential on disk only for an installed harness, and never a signed-out account', async () => {
    vendor.evidence.add(codex.binary!);
    expect(await harnessSignedIn(codex, [account({ status: 'needs_login' })], false)).toBe(false);
    expect(await harnessSignedIn(codex, [account({ status: 'needs_login' })], true)).toBe(true);
  });

  it('is on every provider row, the terminal\'s included, after the Gateway and ClikCode Local', async () => {
    vendor.installed.add('codex');
    const config = { get: () => undefined } as unknown as Conf;
    const rows = await providerRows(config, state([account()]), session());
    expect(rows.slice(0, 2).map((row) => row.id)).toEqual(['gateway', 'clikcode-local']);
    expect(rows.find((row) => row.id === 'codex')).toMatchObject({ installed: true, install: 'ready', signedIn: true, current: true });
  });
});

describe('account rows', () => {
  // The same rule in both copies: one problem per row, verify > reauth > out of usage.
  it('shows the one problem that matters, and the actions that can fix it', () => {
    const spent = { quotaState: 'exhausted' as const, usage: { at: new Date(NOW).toISOString(), windows: [{ name: '5h', usedPct: 100, resetsAt: LATER }] } as AiHarnessAccount['usage'] };
    expect(accountRow(account({ ...spent, status: 'needs_login', verification: { at: '' } as never }), codex, session(), NOW))
      .toMatchObject({ problem: 'verify', actions: ['reauthenticate', 'verified', 'remove'], current: true });
    expect(accountRow(account({ ...spent, status: 'needs_login' }), codex, session(), NOW)).toMatchObject({ problem: 'reauth', actions: ['reauthenticate', 'remove'] });
    expect(accountRow(account(spent), codex, undefined, NOW)).toMatchObject({ problem: 'out-of-usage', actions: ['disconnect'], current: false });
  });
});

describe('usage', () => {
  it('reads current windows first', () => {
    const live = account({ usage: { at: new Date(NOW).toISOString(), label: '5h 40% left', windows: [{ name: '5h', usedPct: 60, resetsAt: LATER }] } as AiHarnessAccount['usage'] });
    vendor.learned = { windows: [{ name: '5h', usedPct: 10 }], label: 'learned' };
    expect(accountUsage(live, state([live]), NOW)).toEqual({ label: '5h 40% left', windows: [{ name: '5h', usedPct: 60, resetsAt: LATER }] });
  });

  it('falls back to what refusals taught once the windows have passed, and says it is an estimate', () => {
    const stale = account({ usage: { at: new Date(NOW).toISOString(), label: '5h 40% left', windows: [{ name: '5h', usedPct: 60, resetsAt: EARLIER }] } as AiHarnessAccount['usage'] });
    vendor.learned = { windows: [{ name: '5h', usedPct: 30, resetsAt: LATER }], label: '5h ~70% left' };
    const usage = accountUsage(stale, state([stale]), NOW)!;
    expect(usage).toMatchObject({ learned: true, label: '5h ~70% left' });
    expect(accountUsageText(usage)).toBe('5h ~70% left · estimated');
  });

  // /usage showed a balance with no window (Auggie, Amp, Kilo); the editor's
  // account list dropped it. The balance is the vendor's own answer: shown.
  it('shows a balance that has no window', () => {
    const balance = account({ usage: { at: new Date(NOW).toISOString(), label: '$3.20 left' } as AiHarnessAccount['usage'] });
    expect(accountUsage(balance, state([balance]), NOW)).toEqual({ label: '$3.20 left', windows: [] });
    expect(accountUsageText({ label: '$3.20 left', windows: [] })).toBe('$3.20 left');
  });
});

describe('effort choices', () => {
  // Settings offered no effort row on the Gateway; /effort and the editor did.
  it('offers the Gateway\'s scale on a Gateway chat', async () => {
    const choices = await effortChoices(state(), session({ route: 'gateway', nativeHarness: undefined, provider: 'gateway', effort: 'platform-managed' }));
    expect(choices).toMatchObject({ gateway: true });
    expect(choices!.choices).toContain('high');
    expect(choices!.current).toBeUndefined();
  });

  // The editor fell back to the generic list when discovery failed, /effort
  // threw: both now fall back to the harness's own catalog list.
  it('falls back to the catalog\'s levels when the harness cannot be asked', async () => {
    expect(await effortChoices(state(), session())).toEqual({ current: 'medium', choices: codex.effortValues });
    vendor.efforts = ['low', 'high'];
    expect((await effortChoices(state(), session()))!.choices).toEqual(['low', 'high']);
  });

  it('offers none on ClikCode Local', async () => {
    expect(await effortChoices(state(), session({ route: 'clikcode-local', nativeHarness: undefined }))).toBeUndefined();
  });
});
