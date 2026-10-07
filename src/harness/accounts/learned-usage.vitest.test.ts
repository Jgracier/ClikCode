import { describe, expect, it, vi } from 'vitest';
import * as catalog from '@clikcode/router/ai-local-harness';

vi.mock('../../runtime/lazy-bridge.js', async (original) => ({
  ...(await original<typeof import('../../runtime/lazy-bridge.js')>()),
  localHarnessForProvider: catalog.localHarnessForProvider,
}));

const { learnedReading, learningFor, learnsUsage, noteAllowedTurn } = await import('./learned-usage.js');
const { recordQuotaRefusal } = await import('../../turn/account-outcome.js');
const { reportedRoom } = await import('../../turn/account-routing.js');
import type { AiHarnessAccount } from '../definition.js';
import type { HarnessState } from '../../session/model.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse('2026-10-03T12:00:00.000Z');

function account(provider: string, extra: Partial<AiHarnessAccount> = {}): AiHarnessAccount {
  return { id: provider, provider, label: provider, authKind: 'vendor-cli', models: [], status: 'ready', credentialRef: `native:${provider}`, ...extra };
}

describe('where usage is learned', () => {
  it('only for a harness that reports none, never where the vendor reports it', () => {
    expect(learnsUsage(account('google'))).toBe(true);
    // Codex and Claude Code report their own windows.
    expect(learnsUsage(account('openai'))).toBe(false);
    expect(learnsUsage(account('anthropic'))).toBe(false);
    // A vendor figure on the account wins, windows or a balance alike.
    expect(learnsUsage(account('google', { usage: { at: new Date(NOW).toISOString(), label: '$3 left' } }))).toBe(false);
    expect(learnsUsage(account('google', { authKind: 'api-key' }))).toBe(false);
    // Grok's probe answers paid plans. A Free account's "Free plan" label is
    // the tier, not a figure, so the refusal can teach the allowance.
    const free = { plan: { name: 'Free' }, usage: { at: new Date(NOW).toISOString(), label: 'Free plan' } };
    expect(learnsUsage(account('xai', free))).toBe(true);
    expect(learnsUsage(account('xai', { usage: { at: new Date(NOW).toISOString(), label: 'Weekly 100% left', windows: [{ name: 'weekly', usedPct: 0 }] } as AiHarnessAccount['usage'] }))).toBe(false);
    expect(learnsUsage(account('xai'))).toBe(false);
  });
});

describe('learning from turns as they happen', () => {
  // Turns of 100 every 10 minutes for four hours, then a 5h-rolling refusal
  // at 2400 that names its reset: when the first of them ages out.
  function history() {
    const user = account('google');
    // The log reaches back two days (another account's turn), so it holds
    // every turn of this one since then -- there were none before these.
    const invocations: HarnessState['invocations'] = [
      { id: 'older', accountId: 'elsewhere', provider: 'openai', at: new Date(NOW - 2 * 24 * HOUR).toISOString(), latencyMs: 1000 },
    ];
    const state = { accounts: [user], sessions: [], invocations } as unknown as HarnessState;
    const start = NOW - 4 * HOUR;
    for (let index = 0; index < 24; index += 1) {
      const invocation = { id: `t${index}`, accountId: user.id, provider: 'google', at: new Date(start + index * 10 * MINUTE + 1000).toISOString(), latencyMs: 1000, totalTokens: 100 };
      invocations.push(invocation);
      noteAllowedTurn(state, user, invocation, start + index * 10 * MINUTE + 1000);
    }
    return { user, state, firstStart: start };
  }

  it('builds the ledger from the turns, and learns the window and reset from refusals', () => {
    const { user, state, firstStart } = history();
    expect(learningFor(state, user, NOW).turns).toHaveLength(24);
    const named = new Date(firstStart + 5 * HOUR).toISOString();
    recordQuotaRefusal(state, user, Object.assign(new Error('quota'), { stderrTail: `Resets in 1h0m0s.` }), NOW);
    expect(user.quotaRetryAt).toBe(named);
    const reading = learnedReading(state, user, NOW);
    expect(reading?.windows[0]?.name).toBe('5h');
    expect(reading?.windows[0]?.usedPct).toBeGreaterThanOrEqual(100);
    expect(reading?.label).toMatch(/^5h ~0% left$/);
  });

  it('ends a refusal that named no reset when the learned window resets, not after a guess', () => {
    const { user, state, firstStart } = history();
    // Taught once by a refusal that named its reset...
    recordQuotaRefusal(state, user, Object.assign(new Error('quota'), { stderrTail: 'Resets in 1h0m0s.' }), NOW);
    // ...a turn allowed once it reset, and refused again later, unnamed.
    const after = firstStart + 5 * HOUR + MINUTE;
    const invocation = { id: 'after', accountId: user.id, provider: 'google', at: new Date(after + 1000).toISOString(), latencyMs: 1000, totalTokens: 100 };
    state.invocations.push(invocation);
    noteAllowedTurn(state, user, invocation, after + 1000);
    recordQuotaRefusal(state, user, new Error('quota'), after + 2 * MINUTE);
    // The oldest turn in the 5h window ages out next: the second one's start.
    expect(user.quotaRetryAt).toBe(new Date(firstStart + 10 * MINUTE + 5 * HOUR).toISOString());
  });

  it('ranks by learned room for a harness that reports none, and by the vendor for one that does', () => {
    const { user, state } = history();
    recordQuotaRefusal(state, user, Object.assign(new Error('quota'), { stderrTail: 'Resets in 1h0m0s.' }), NOW);
    expect(reportedRoom(state, user, NOW)).toBe(0);
    const codex = account('openai', { usage: { at: new Date(NOW).toISOString(), label: '5h 70% left', windows: [{ name: '5h', usedPct: 30, resetsAt: new Date(NOW + HOUR).toISOString() }] } as AiHarnessAccount['usage'] });
    expect(reportedRoom(state, codex, NOW)).toBe(70);
    expect(learnedReading(state, codex, NOW)).toBeUndefined();
  });
});

const GROK_FREE = "Rate limited: API error (status 429 Too Many Requests): subscription:free-usage-exhausted: You've used all the included free usage for model grok-4.7 for now. Usage resets over a rolling 24-hour window — tokens (actual/limit): 603117/500000";

describe('a Grok free account that has run out', () => {
  it('shows the learned daily usage and when it resets, from the turns it allowed', () => {
    const user = account('xai', { plan: { name: 'Free' }, usage: { at: new Date(NOW).toISOString(), label: 'Free plan' } });
    const invocations: HarnessState['invocations'] = [];
    const state = { accounts: [user], sessions: [], invocations } as unknown as HarnessState;
    // One turn before the window, so the ledger covers it, then ten inside
    // it. The oldest of those ages out an hour from now.
    invocations.push({ id: 'before', accountId: user.id, provider: 'xai', at: new Date(NOW - 25 * HOUR).toISOString(), latencyMs: 0, totalTokens: 100 });
    for (let index = 0; index < 10; index += 1) {
      const start = NOW - 23 * HOUR + index * HOUR;
      invocations.push({ id: `t${index}`, accountId: user.id, provider: 'xai', at: new Date(start).toISOString(), latencyMs: 0, totalTokens: 100 });
    }
    recordQuotaRefusal(state, user, new Error(GROK_FREE), NOW);
    const reading = learnedReading(state, user, NOW);
    expect(reading?.windows[0]?.name).toBe('daily');
    expect(reading?.windows[0]?.usedPct).toBeGreaterThanOrEqual(100);
    expect(reading?.label).toMatch(/^Daily ~0% left$/);
    // The oldest spend inside the 24h ages out before a full day from now.
    const reset = Date.parse(reading!.windows[0]!.resetsAt!);
    expect(reset).toBeGreaterThan(NOW);
    expect(reset).toBeLessThan(NOW + 24 * HOUR);
    expect(user.quotaRetryAt).toBe(reading!.windows[0]!.resetsAt);
  });

  it('still says when a first refusal ends before any turn was recorded', () => {
    const user = account('xai');
    const state = { accounts: [user], sessions: [], invocations: [] } as unknown as HarnessState;
    recordQuotaRefusal(state, user, new Error(GROK_FREE), NOW);
    expect(user.plan).toEqual({ name: 'Free' });
    const reading = learnedReading(state, user, NOW);
    expect(reading?.label).toBe('Daily ~0% left');
    expect(reading?.windows[0]?.usedPct).toBe(100);
    expect(user.quotaRetryAt).toBe(new Date(NOW + 24 * HOUR).toISOString());
    expect(reading?.windows[0]?.resetsAt).toBe(user.quotaRetryAt);
  });
});
