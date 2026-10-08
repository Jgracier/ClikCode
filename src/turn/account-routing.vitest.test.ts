import { describe, expect, it, vi } from 'vitest';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessSession, HarnessState } from '../session/model.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import type { AccountFailureKind } from './failover.js';
import { nextUsableFailoverAccount, providerHasAccountForTurn } from './account-routing.js';
import { accountAfterFailure, initialAccountChoice, matchesDirectTurnModel, terminalFailoverError, turnAccounts, turnBackendForAccount, type FailoverTally } from './account-routing.js';

vi.mock('../runtime/lazy-bridge.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../runtime/lazy-bridge.js')>(),
  isDirectModelProvider: (provider: string) => provider === 'anthropic',
}));

function account(id: string, extra: Partial<AiHarnessAccount> = {}): AiHarnessAccount {
  return {
    id, provider: 'anthropic', label: id, authKind: 'vendor-cli', models: [], status: 'ready',
    credentialRef: `native:${id}`, ...extra,
  };
}

function state(accounts: AiHarnessAccount[], invocations: HarnessState['invocations'] = []): HarnessState {
  return {
    version: 1, installationId: 'test', localApiToken: 't', devicePrivateKeyPem: '', devicePublicKey: {},
    accounts, sessions: [], invocations, globalSettings: { effort: 'medium', permissionMode: 'ask' },
    providerSettings: {},
  };
}

const later = new Date(Date.now() + 86_400_000).toISOString();
const earlier = new Date(Date.now() - 86_400_000).toISOString();

describe('stored-usage account switch', () => {
  it('can fail over to an API-key account served by the same vendor CLI', () => {
    const current = account('current', { provider: 'aider', quotaState: 'exhausted' });
    const key = account('key', { provider: 'aider', authKind: 'api-key', credentialRef: 'env:OPENAI_API_KEY' });
    expect(turnBackendForAccount(key)).toBe('vendor');
    expect(nextUsableFailoverAccount(
      state([current, key]), current, (candidate) => turnBackendForAccount(candidate) === 'vendor', new Map(),
    )?.id).toBe('key');
  });

  it('goes back to an account this turn already tried once the reset it named has passed', () => {
    // Codex: account A said "try again at 10:38", B ran out at 10:39 -- and
    // the turn said "All accounts exhausted" with A back a minute earlier.
    const back = account('back', { quotaState: 'exhausted', quotaRetryAt: earlier });
    const current = account('current', { quotaState: 'exhausted', quotaRetryAt: later });
    const triedBefore = Date.now() - 2 * 86_400_000;
    expect(nextUsableFailoverAccount(state([current, back]), current, () => true, new Map([['back', triedBefore]]))?.id).toBe('back');
    const stillOut = account('still-out', { quotaState: 'exhausted', quotaRetryAt: later });
    expect(nextUsableFailoverAccount(state([current, stillOut]), current, () => true, new Map([['still-out', triedBefore]]))).toBeUndefined();
    // Tried and refused for something that names no reset: not again this turn.
    expect(nextUsableFailoverAccount(state([current, account('throttled')]), current, () => true, new Map([['throttled', triedBefore]]))).toBeUndefined();
  });

  it('does not walk two throttled accounts A, B, A forever on resets that had passed before they were tried', async () => {
    const a = account('a', { quotaState: 'exhausted', quotaRetryAt: earlier });
    const b = account('b', { quotaState: 'exhausted', quotaRetryAt: earlier });
    const tally: FailoverTally = { attempted: new Map(), exhaustedAny: false };
    const held = state([a, b]);
    const after = (from: AiHarnessAccount) => accountAfterFailure({
      state: held, account: from, failure: new Error('429 too many requests'), kind: 'temporarily-throttled',
      matchesBackend: () => true, tally, persist: async () => undefined,
    });
    expect((await after(a)).id).toBe('b');
    const failure = await after(b).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('429 too many requests');
  });

  it('skips a known spent account before the turn and records that attempt', () => {
    const current = account('current', { quotaState: 'exhausted', quotaExhaustedAt: new Date().toISOString() });
    const next = account('next');
    const attempted = new Map<string, number>();
    expect(initialAccountChoice(state([current, next]), current, () => true, attempted))
      .toEqual({ kind: 'switch', account: next });
    expect([...attempted.keys()]).toEqual(['current']);
  });

  it('sends to the vendor when the only hold is a guess and nothing else can run', () => {
    // A refusal that named no reset: ClikCode guessed how long it holds.
    const guessed = account('guessed', { quotaState: 'exhausted', quotaExhaustedAt: new Date().toISOString() });
    const attempted = new Map<string, number>();
    expect(initialAccountChoice(state([guessed]), guessed, () => true, attempted)).toEqual({ kind: 'continue' });
    expect(attempted.size).toBe(0);
    // The vendor's own reset still refuses here.
    const stated = account('stated', { quotaState: 'exhausted', quotaExhaustedAt: new Date().toISOString(), quotaRetryAt: later });
    expect(initialAccountChoice(state([stated]), stated, () => true, new Map()).kind).toBe('exhausted');
  });

  it('keeps direct API failover on an account that serves the selected model', () => {
    const direct = account('direct', { authKind: 'api-key', credentialRef: 'env:ANTHROPIC_API_KEY', models: ['claude-sonnet'] });
    expect(matchesDirectTurnModel(direct, 'claude-sonnet')).toBe(true);
    expect(matchesDirectTurnModel(direct, 'other-model')).toBe(false);
    expect(turnBackendForAccount(account('native'))).toBe('vendor');
  });

  it('reports the actual failure when another account still has quota', () => {
    const spent = account('spent', { quotaState: 'exhausted', quotaExhaustedAt: new Date().toISOString() });
    const crashed = account('crashed');
    const quotaFailure = new Error('quota reached');
    const otherFailure = new Error('connection reset');
    const result = terminalFailoverError({
      state: state([spent, crashed]), current: crashed,
      matchesBackend: () => true, exhaustedAny: true, lastFailure: quotaFailure, lastOtherFailure: otherFailure,
    });
    expect(result).toBe(otherFailure);
  });

  it('does not treat the account that just refused as one that can still run', () => {
    const open = account('open');
    const result = terminalFailoverError({
      state: state([open]), current: open, matchesBackend: () => true, exhaustedAny: true,
      lastFailure: new Error("You've hit your usage limit"), attempted: new Map([['open', Date.now()]]),
    });
    expect((result as Error).message).toContain('All accounts exhausted');
  });

  it('reports exhaustion only after every matching account is spent', () => {
    const spent = account('spent', { quotaState: 'exhausted', quotaExhaustedAt: new Date().toISOString() });
    const result = terminalFailoverError({
      state: state([spent]), current: spent,
      matchesBackend: () => true, exhaustedAny: true, lastFailure: new Error('quota reached'),
    });
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('All accounts exhausted');
  });

  it('picks the account with room left and skips one already refused, even when its saved percent still looks open', () => {
    const empty = account('empty', {
      quotaState: 'exhausted',
      usage: { at: new Date().toISOString(), label: 'weekly 40% left', windows: [{ name: 'weekly', usedPct: 60, resetsAt: later }] } as AiHarnessAccount['usage'],
    });
    const full = account('full', {
      usage: { at: new Date().toISOString(), label: 'weekly 80% left', windows: [{ name: 'weekly', usedPct: 20, resetsAt: later }] } as AiHarnessAccount['usage'],
    });
    const current = account('current', { quotaState: 'exhausted' });
    const picked = nextUsableFailoverAccount(state([current, empty, full]), current, () => true, new Map());
    expect(picked?.id).toBe('full');
    expect(empty.quotaState).toBe('exhausted');
  });

  it('does not start on an account whose saved window is already spent, and writes nothing to it', () => {
    const spent = account('spent', {
      usage: { at: new Date().toISOString(), label: 'weekly 0% left', windows: [{ name: 'weekly', usedPct: 100, resetsAt: later }] } as AiHarnessAccount['usage'],
    });
    const next = account('next');
    expect(initialAccountChoice(state([spent, next]), spent, () => true, new Map()))
      .toEqual({ kind: 'switch', account: next });
    expect(spent.quotaState).toBeUndefined();
  });

  it('tries an account with no displayed usage, behind one that shows room', () => {
    const unknown = account('unknown');
    const room = account('room', {
      usage: { at: new Date().toISOString(), label: 'weekly 10% left', windows: [{ name: 'weekly', usedPct: 90, resetsAt: later }] } as AiHarnessAccount['usage'],
    });
    const current = account('current', { quotaState: 'exhausted' });
    expect(nextUsableFailoverAccount(state([current, unknown, room]), current, () => true, new Map())?.id).toBe('room');
    expect(nextUsableFailoverAccount(state([current, unknown]), current, () => true, new Map())?.id).toBe('unknown');
  });

  it('ignores a positive percent that has no window, so it cannot outrank a real reading or clear a refusal', () => {
    const stale = account('stale', {
      quotaState: 'exhausted',
      usage: { at: new Date().toISOString(), label: 'weekly 40% left' },
    });
    const room = account('room', {
      usage: { at: new Date().toISOString(), label: 'weekly 5% left', windows: [{ name: 'weekly', usedPct: 95, resetsAt: later }] } as AiHarnessAccount['usage'],
    });
    const current = account('current');
    expect(nextUsableFailoverAccount(state([current, stale, room]), current, () => true, new Map())?.id).toBe('room');
    expect(stale.quotaState).toBe('exhausted');
  });

  it('keeps an account with room in rotation after turns on it: only the vendor says it is out', () => {
    // The reported bug: two Codex accounts with 99% and 49% left were marked
    // out of usage after one ordinary turn each.
    const roomy = account('roomy', {
      usage: { at: earlier, label: '5h 99% left · Weekly 93% left', windows: [{ name: '5h', usedPct: 1, resetsAt: later }, { name: 'weekly', usedPct: 7, resetsAt: later }] } as AiHarnessAccount['usage'],
    });
    const half = account('half', {
      usage: { at: earlier, label: '5h 49% left · Weekly 75% left', windows: [{ name: '5h', usedPct: 51, resetsAt: later }, { name: 'weekly', usedPct: 25, resetsAt: later }] } as AiHarnessAccount['usage'],
    });
    const invocations = ['roomy', 'half'].map((id) => (
      { id: `turn-${id}`, accountId: id, provider: 'anthropic', at: new Date().toISOString(), totalTokens: 5_000_000, latencyMs: 1 }
    ));
    const held = state([roomy, half], invocations);
    expect(nextUsableFailoverAccount(held, account('current'), () => true, new Map())?.id).toBe('roomy');
    expect(nextUsableFailoverAccount(held, account('current'), () => true, new Map([['roomy', Date.now()]]))?.id).toBe('half');
    expect([roomy.quotaState, half.quotaState]).toEqual([undefined, undefined]);
  });

  it('still skips a spent window after a later turn; emptiness does not go stale', () => {
    const spent = account('spent', {
      usage: { at: earlier, label: 'weekly 0% left', windows: [{ name: 'weekly', usedPct: 100, resetsAt: later }] } as AiHarnessAccount['usage'],
    });
    const invocations = [
      { id: 'later-turn', accountId: 'spent', provider: 'anthropic', at: new Date().toISOString(), totalTokens: 50, latencyMs: 1 },
    ];
    expect(nextUsableFailoverAccount(state([spent], invocations), account('current'), () => true, new Map())).toBeUndefined();
  });

  it('lets a refused account back in once every spent window has reset', () => {
    const returned = account('returned', {
      quotaState: 'exhausted',
      usage: { at: earlier, label: 'weekly 0% left', windows: [{ name: 'weekly', usedPct: 100, resetsAt: earlier }] } as AiHarnessAccount['usage'],
    });
    expect(nextUsableFailoverAccount(state([returned]), account('current'), () => true, new Map())?.id).toBe('returned');
  });

  it('fails over to a same-provider account whose quota came back, ahead of one with nothing known', () => {
    const recovered = account('recovered', {
      quotaState: 'exhausted', quotaExhaustedAt: new Date(Date.now() - 13 * 3_600_000).toISOString(),
      usage: { at: new Date(Date.now() - 12 * 3_600_000).toISOString(), label: '5h 0% left', windows: [{ name: '5h', usedPct: 100, resetsAt: new Date(Date.now() - 10 * 3_600_000).toISOString() }] } as AiHarnessAccount['usage'],
    });
    const current = account('current', { quotaState: 'exhausted', quotaExhaustedAt: new Date().toISOString() });
    const other = account('other', { provider: 'openai' });
    expect(nextUsableFailoverAccount(state([current, other, recovered]), current, () => true, new Map())?.id).toBe('recovered');
  });

  it('never fails over to an account waiting on verification', () => {
    const pending = account('pending', { quotaState: 'available', verification: { at: new Date().toISOString() } });
    const current = account('current', { quotaState: 'exhausted', quotaExhaustedAt: new Date().toISOString() });
    expect(nextUsableFailoverAccount(state([current, pending]), current, () => true, new Map())).toBeUndefined();
  });

  it('tries an unreadable-vendor account again once its refusal expired, and not before', () => {
    const expired = account('expired', { provider: 'antigravity', quotaState: 'exhausted', quotaExhaustedAt: new Date(Date.now() - 6 * 3_600_000).toISOString() });
    const recent = account('recent', { provider: 'antigravity', quotaState: 'exhausted', quotaExhaustedAt: new Date(Date.now() - 3_600_000).toISOString() });
    const current = account('current', { provider: 'antigravity', quotaState: 'exhausted', quotaExhaustedAt: new Date().toISOString() });
    expect(nextUsableFailoverAccount(state([current, recent, expired]), current, () => true, new Map())?.id).toBe('expired');
  });

  it('calls a provider exhausted only when none of its accounts can take the turn', () => {
    const spent = account('spent', { quotaState: 'exhausted', quotaExhaustedAt: new Date().toISOString() });
    const pending = account('pending', { verification: { at: new Date().toISOString() } });
    const crashed = account('crashed');
    const elsewhere = account('elsewhere', { provider: 'openai' });
    expect(providerHasAccountForTurn(state([spent, pending, elsewhere]), 'anthropic', () => true)).toBe(false);
    // An account that failed some other way still has its quota.
    expect(providerHasAccountForTurn(state([spent, pending, crashed]), 'anthropic', () => true)).toBe(true);
  });
});

describe('the failover step both account backends take', () => {
  const step = (input: { accounts: AiHarnessAccount[]; failure: unknown; kind: AccountFailureKind; signal?: AbortSignal }) => {
    const tally: FailoverTally = { attempted: new Map(), exhaustedAny: false };
    const persist = vi.fn(async () => undefined);
    const result = accountAfterFailure({
      state: state(input.accounts), account: input.accounts[0]!, failure: input.failure, kind: input.kind,
      ...(input.signal ? { signal: input.signal } : {}), matchesBackend: () => true, tally, persist,
    });
    return { result, tally, persist };
  };

  it('ends on a failure that is not the account\'s, instead of retelling the turn on every account', async () => {
    // A Grok turn walked four accounts in an hour this way, retold onto a
    // fresh thread at each, until the model only repeated the retelling.
    const crashed = account('crashed');
    const segfault = new Error('segfault');
    await expect(step({ accounts: [crashed, account('next')], failure: segfault, kind: 'other' }).result).rejects.toBe(segfault);
    expect(crashed.quotaState).toBeUndefined();
  });

  it('moves on for what another account fixes, and marks spent only a quota refusal', async () => {
    for (const kind of ['temporarily-throttled', 'authentication-required', 'account-ineligible'] as const) {
      const first = account('first');
      const { result, tally } = step({ accounts: [first, account('next')], failure: new Error('429 too many requests'), kind });
      expect((await result).id, kind).toBe('next');
      expect(tally.exhaustedAny, kind).toBe(false);
      expect(first.quotaState, kind).toBeUndefined();
      // The one place a lost sign-in is recorded, for both backends.
      expect(first.status, kind).toBe(kind === 'authentication-required' ? 'needs_login' : 'ready');
    }
  });

  it('stops on Esc instead of walking the accounts', async () => {
    // The direct API-key path had no guard: the abort was classed "other" and
    // retried on every account with the already-aborted signal.
    const controller = new AbortController();
    controller.abort();
    const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    const { result, tally } = step({ accounts: [account('first'), account('second')], failure: abort, kind: 'other', signal: controller.signal });
    await expect(result).rejects.toMatchObject({ code: 'ERR_TURN_CANCELLED' });
    expect(tally.attempted.size).toBe(0);
  });

  it('ends on a stall instead of starting the request over on another account', async () => {
    const stalled = Object.assign(new Error('Codex produced no output for 600s and was stopped'), { reason: 'idle-timeout' });
    await expect(step({ accounts: [account('a'), account('b')], failure: stalled, kind: 'other' }).result).rejects.toBe(stalled);
  });

  it('marks a refusal until the reset of the window its reading showed spent', async () => {
    const spent = account('spent', {
      usage: { at: earlier, windows: [{ name: 'weekly', usedPct: 100, resetsAt: later }] } as AiHarnessAccount['usage'],
    });
    await step({ accounts: [spent, account('next')], failure: new Error('quota reached'), kind: 'quota-exhausted' }).result;
    expect(spent.quotaRetryAt).toBe(later);
  });

  it('surfaces a rejected request without trying another account', async () => {
    const refused = new Error('--effort is not supported for model x');
    await expect(step({ accounts: [account('a'), account('b')], failure: refused, kind: 'request-invalid' }).result).rejects.toBe(refused);
  });

  it('moves a usage refusal to the account whose usage came back on disk', async () => {
    const current = account('current');
    const stale = account('other', { quotaState: 'exhausted', quotaExhaustedAt: new Date().toISOString() });
    const disk = await readState({ transcripts: [] });
    disk.accounts.push(account('other'));
    await writeState(disk);
    const accounts = turnAccounts({
      state: state([current, stale]), session: { id: 's', accountId: current.id } as HarnessSession,
      matchesBackend: () => true, persist: async () => undefined, current: () => current, adopt: () => undefined,
    });
    expect((await accounts.after(new Error("You've hit your usage limit. try again at 12:12 PM."), 'quota-exhausted')).id).toBe('other');
  });

  it('stops on model capacity instead of trying the account that still has usage', async () => {
    const current = account('current');
    const open = account('other');
    const failure = new Error('Selected model is at capacity. Please try a different model.');
    const accounts = turnAccounts({
      state: state([current, open]), session: { id: 's', accountId: current.id } as HarnessSession,
      matchesBackend: () => true, persist: async () => undefined, current: () => current, adopt: () => undefined,
    });
    await expect(accounts.after(failure, 'other')).rejects.toBe(failure);
  });

  it('tries another account on a usage limit', async () => {
    const first = account('first');
    const other = account('other');
    const accounts = turnAccounts({
      state: state([first, other]), session: { accountId: first.id } as HarnessSession,
      matchesBackend: () => true, persist: async () => undefined, current: () => first, adopt: () => undefined,
    });
    expect((await accounts.after(new Error('quota reached'), 'quota-exhausted')).id).toBe('other');
    const spent = account('only');
    const exhausted = step({ accounts: [spent], failure: new Error('quota reached'), kind: 'quota-exhausted' });
    await expect(exhausted.result).rejects.toThrow(/Usage Exhausted|exhausted/i);
  });
});
