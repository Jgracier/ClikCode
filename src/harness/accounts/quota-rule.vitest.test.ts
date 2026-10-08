import { describe, expect, it } from 'vitest';
import type { AiHarnessAccount } from '../definition.js';
import type { HarnessState } from '../../session/model.js';
import { accountCanTakeTurn, accountQuotaSpent, QUOTA_MARK_DEFAULT_MS, settleQuotaMark } from './usage-reading.js';
import { accountsDueForUsageRecheck } from './account-usage.js';

const now = Date.parse('2026-09-27T15:00:00.000Z');
const minutes = (count: number): string => new Date(now + count * 60_000).toISOString();

function account(fields: Partial<AiHarnessAccount> = {}): AiHarnessAccount {
  return { id: 'a', provider: 'anthropic', label: 'a', authKind: 'vendor-cli', models: [], status: 'ready', credentialRef: 'native:a', ...fields };
}
const reading = (at: string, windows: Array<{ name: string; usedPct: number; resetsAt?: string }>) =>
  ({ at, label: 'x', windows }) as AiHarnessAccount['usage'];

describe('can an account take a turn now', () => {
  it('lets back an account marked exhausted whose spent window reset hours ago', () => {
    // The user's justin@webpro.ai: refused, read once, never again.
    const webpro = account({
      quotaState: 'exhausted', quotaExhaustedAt: minutes(-780),
      usage: reading(minutes(-752), [{ name: '5h', usedPct: 100, resetsAt: minutes(-624) }, { name: 'weekly', usedPct: 56, resetsAt: minutes(3865) }]),
    });
    expect(accountCanTakeTurn(webpro, now)).toBe(true);
    expect(settleQuotaMark(webpro, now)).toBe(true);
    expect(webpro.quotaState).toBe('available');
  });

  it('keeps an account out while a spent window is still ahead of its reset', () => {
    const spent = account({ usage: reading(minutes(-5), [{ name: '5h', usedPct: 100, resetsAt: minutes(200) }]) });
    expect(accountQuotaSpent(spent, now)).toBe(true);
    expect(accountCanTakeTurn(spent, now)).toBe(false);
  });

  it('does not let a window that had already reset before the refusal clear it', () => {
    const refusedLater = account({
      quotaState: 'exhausted', quotaExhaustedAt: minutes(-10),
      usage: reading(minutes(-120), [{ name: '5h', usedPct: 100, resetsAt: minutes(-60) }]),
    });
    expect(accountCanTakeTurn(refusedLater, now)).toBe(false);
  });

  it('clears a refusal once a reading taken after it shows room, but not one taken before it', () => {
    const after = account({ quotaState: 'exhausted', quotaExhaustedAt: minutes(-30), usage: reading(minutes(-1), [{ name: '5h', usedPct: 40, resetsAt: minutes(100) }]) });
    const before = account({ quotaState: 'exhausted', quotaExhaustedAt: minutes(-30), usage: reading(minutes(-60), [{ name: '5h', usedPct: 40, resetsAt: minutes(100) }]) });
    expect(accountCanTakeTurn(after, now)).toBe(true);
    expect(accountCanTakeTurn(before, now)).toBe(false);
  });

  it('expires a mark on a vendor with no readable usage after the default window', () => {
    const fresh = account({ provider: 'antigravity', quotaState: 'exhausted', quotaExhaustedAt: minutes(-60) });
    const old = account({ provider: 'antigravity', quotaState: 'exhausted', quotaExhaustedAt: new Date(now - QUOTA_MARK_DEFAULT_MS - 1).toISOString() });
    expect(accountCanTakeTurn(fresh, now)).toBe(false);
    expect(accountCanTakeTurn(old, now)).toBe(true);
  });

  it("holds a mark until the vendor's own reset hint, longer or shorter than the default", () => {
    const hinted = account({ provider: 'antigravity', quotaState: 'exhausted', quotaExhaustedAt: minutes(-600), quotaRetryAt: minutes(4000) });
    const soon = account({ provider: 'antigravity', quotaState: 'exhausted', quotaExhaustedAt: minutes(-10), quotaRetryAt: minutes(-1) });
    expect(accountCanTakeTurn(hinted, now)).toBe(false);
    expect(accountCanTakeTurn(soon, now)).toBe(true);
  });

  it('does not uphold a mark with no date, which says nothing about how long it holds', () => {
    expect(accountCanTakeTurn(account({ provider: 'antigravity', quotaState: 'exhausted' }), now)).toBe(true);
  });

  it('does not let a reading of only advisory windows clear a refusal', () => {
    // Antigravity's pools, Cline's credits: shown, never what says there is room.
    const pools = account({
      provider: 'antigravity', quotaState: 'exhausted', quotaExhaustedAt: minutes(-30),
      usage: reading(minutes(-1), [{ name: 'gemini', usedPct: 20, resetsAt: minutes(100), advisory: true } as never]),
    });
    expect(accountCanTakeTurn(pools, now)).toBe(false);
    expect(settleQuotaMark(pools, now)).toBe(false);
    expect(pools.quotaState).toBe('exhausted');
  });

  it('keeps a spent window with no reset until a newer reading says otherwise', () => {
    const spent = account({ usage: reading(minutes(-5), [{ name: '5h', usedPct: 100 }]) });
    expect(accountCanTakeTurn(spent, now)).toBe(false);
    expect(accountCanTakeTurn(account({ usage: reading(minutes(-1), [{ name: '5h', usedPct: 20 }]) }), now)).toBe(true);
  });

  it('decides on the unrounded figure: 99.6% used is not spent', () => {
    expect(accountCanTakeTurn(account({ usage: reading(minutes(-1), [{ name: '5h', usedPct: 99.6, resetsAt: minutes(60) }]) }), now)).toBe(true);
  });

  it('ignores a failed reading, so a probe error never marks an account out', () => {
    const failed = account({ usage: { at: minutes(-1), failed: true, windows: [{ name: '5h', usedPct: 100, resetsAt: minutes(60) }] } as AiHarnessAccount['usage'] });
    expect(accountCanTakeTurn(failed, now)).toBe(true);
  });

  it('never counts an account the vendor holds for verification, or one signed out', () => {
    expect(accountCanTakeTurn(account({ quotaState: 'available', verification: { at: minutes(-5) } }), now)).toBe(false);
    expect(accountCanTakeTurn(account({ status: 'needs_login' }), now)).toBe(false);
    expect(accountCanTakeTurn(account(), now)).toBe(true);
  });
});

describe('which accounts are re-read', () => {
  const state = (accounts: AiHarnessAccount[]): HarnessState => ({ accounts } as unknown as HarnessState);
  // Claude has a usage probe; the others here have none.
  const askable = (item: AiHarnessAccount): boolean => item.provider === 'anthropic';

  it('re-reads any held account nobody has asked about for a minute, dated reset or not', () => {
    // Vendors round their resets ("resets 11am" came back at 10:50), so a
    // dated hold is re-read too rather than waited out.
    const dated = account({ id: 'd', quotaState: 'exhausted', quotaExhaustedAt: minutes(-10), quotaRetryAt: minutes(60), usage: reading(minutes(-5), [{ name: '5h', usedPct: 100, resetsAt: minutes(200) }]) });
    const guessed = account({ id: 'g', quotaState: 'exhausted', quotaExhaustedAt: minutes(-30) });
    const justAsked = account({ id: 'j', quotaState: 'exhausted', quotaExhaustedAt: minutes(-30), usageCheckedAt: new Date(now - 20_000).toISOString() });
    const healthy = account({ id: 'h', usage: reading(minutes(-5), [{ name: '5h', usedPct: 30, resetsAt: minutes(-1) }]) });
    expect(accountsDueForUsageRecheck(state([dated, guessed, justAsked, healthy]), now, askable).map((item) => item.id)).toEqual(['d', 'g']);
  });

  it('re-reads a spent window that never said when it resets, which nothing else would', () => {
    const undated = account({ id: 'u', usage: reading(minutes(-60), [{ name: '5h', usedPct: 100 }]) });
    expect(accountsDueForUsageRecheck(state([undated]), now, askable).map((item) => item.id)).toEqual(['u']);
  });

  it('re-reads an expired refusal with no reading since, but not a vendor it cannot ask', () => {
    const expired = account({ id: 'e', quotaState: 'exhausted', quotaExhaustedAt: minutes(-400) });
    const unreadable = account({ id: 'g', provider: 'antigravity', quotaState: 'exhausted', quotaExhaustedAt: minutes(-400) });
    expect(accountsDueForUsageRecheck(state([expired, unreadable]), now, askable).map((item) => item.id)).toEqual(['e']);
  });
});

describe('a reading the vendor proved wrong', () => {
  it('stops counting a spent window once a turn was served through it, until a refusal', async () => {
    const { recordSuccessfulAccountTurn, recordQuotaRefusal } = await import('../../turn/account-outcome.js');
    const weekly = { name: 'weekly', usedPct: 100, resetsAt: minutes(2_000) };
    const served = account({ usage: reading(minutes(-1), [weekly]) });
    const state = { accounts: [served], sessions: [], invocations: [] } as unknown as HarnessState;
    expect(accountQuotaSpent(served, now)).toBe(true);
    recordSuccessfulAccountTurn(state, served, { id: 'i', accountId: 'a', provider: 'anthropic', at: new Date(now).toISOString(), latencyMs: 1_000 } as never);
    expect(accountQuotaSpent(served, now)).toBe(false);
    // The next reading says the same thing; it is still not believed.
    served.usage = reading(new Date(now + 60_000).toISOString(), [weekly]);
    expect(accountQuotaSpent(served, now + 60_000)).toBe(false);
    recordQuotaRefusal(state, served, new Error('usage limit reached'), now + 120_000);
    expect(accountQuotaSpent(served, now + 120_000)).toBe(true);
  });
});
