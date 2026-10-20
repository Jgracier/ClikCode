import { beforeEach, describe, expect, it } from 'vitest';
import { forgetCompactedByContext, noteCompactedByContext, shouldCompactByContext, workerIsBusy, COMPACT_REGROWTH_TOKENS } from './compact-by-context.js';
import { compactAtLabel, compactThreshold, DEFAULT_COMPACT_AT_TOKENS, parseCompactAt } from '../session/compact-setting.js';
import { applyDefaultSetting } from '../session/options.js';
import { nativeAvailableCommands } from '../turn/vendor-process.js';
import type { HarnessSession, HarnessState } from '../session/model.js';

let counter = 0;
const session = (over: Partial<HarnessSession> = {}, used = 300_000, window = 1_000_000): HarnessSession => ({
  id: `size-${++counter}`, route: 'local', provider: 'anthropic', nativeHarness: 'claude', accountId: 'a', nativeSessionId: 'n1',
  model: 'opus', effort: 'medium', status: 'active', createdAt: '', updatedAt: '', messages: [{ role: 'user', content: 'hi' }],
  lastUsage: { contextUsed: used, contextWindow: window, at: '' }, ...over,
} as HarnessSession);
const settings = (compactAt?: number): Pick<HarnessState, 'globalSettings'> => ({ globalSettings: { effort: 'medium', permissionMode: 'ask', ...(compactAt !== undefined ? { compactAt } : {}) } });
const withUsed = (s: HarnessSession, used: number): HarnessSession => ({ ...s, lastUsage: { ...s.lastUsage!, contextUsed: used } });

beforeEach(() => forgetCompactedByContext());

describe('compacting by context size', () => {
  it('crosses the default threshold: 249,999 waits, 250,000 compacts', () => {
    expect(shouldCompactByContext(settings(), session({}, DEFAULT_COMPACT_AT_TOKENS - 1))).toBe(false);
    expect(shouldCompactByContext(settings(), session({}, DEFAULT_COMPACT_AT_TOKENS))).toBe(true);
  });

  it('follows the user\'s threshold, and off (0) never compacts', () => {
    expect(shouldCompactByContext(settings(400_000), session({}, 300_000))).toBe(false);
    expect(shouldCompactByContext(settings(100_000), session({}, 300_000))).toBe(true);
    expect(shouldCompactByContext(settings(0), session({}, 900_000))).toBe(false);
  });

  it('is held to the model\'s window: 80% of 200k is 160k, however high the setting', () => {
    expect(compactThreshold({ compactAt: 500_000 }, 200_000)).toBe(160_000);
    expect(shouldCompactByContext(settings(500_000), session({}, 170_000, 200_000))).toBe(true);
    expect(shouldCompactByContext(settings(500_000), session({}, 150_000, 200_000))).toBe(false);
  });

  it('reads the size from the percent of the window when that is all the harness says', () => {
    const kiro = session({ lastUsage: { contextPercent: 60, contextWindow: 500_000, at: '' } as never });
    expect(shouldCompactByContext(settings(), kiro)).toBe(true);
    expect(shouldCompactByContext(settings(), session({ lastUsage: { at: '' } as never }))).toBe(false);
  });

  it('does not repeat: not again at the same size, nor before it has grown by the margin', () => {
    const chat = session({}, 300_000);
    expect(shouldCompactByContext(settings(), chat)).toBe(true);
    noteCompactedByContext(chat);
    expect(shouldCompactByContext(settings(), chat)).toBe(false);
    expect(shouldCompactByContext(settings(), withUsed(chat, 300_000 + COMPACT_REGROWTH_TOKENS - 1))).toBe(false);
    expect(shouldCompactByContext(settings(), withUsed(chat, 300_000 + COMPACT_REGROWTH_TOKENS))).toBe(true);
  });

  it('once it worked (the context fell under the threshold) the threshold alone decides again', () => {
    const chat = session({}, 600_000);
    noteCompactedByContext(chat);
    expect(shouldCompactByContext(settings(), withUsed(chat, 40_000))).toBe(false);
    // Grown back to 300k, which is under where it last ran but over the threshold.
    expect(shouldCompactByContext(settings(), withUsed(chat, 300_000))).toBe(true);
  });

  it('a compaction that left the context over the threshold does not loop', () => {
    const chat = session({}, 600_000);
    noteCompactedByContext(chat);
    expect(shouldCompactByContext(settings(), withUsed(chat, 400_000))).toBe(false);
  });

  it('waits behind a message the user queued, but not behind a notification', () => {
    const queued = session({ queuedTurns: [{ id: 'q', text: 'next', submittedAt: '' }] as never });
    expect(shouldCompactByContext(settings(), queued)).toBe(false);
    const notified = session({ queuedTurns: [{ id: 'n', kind: 'notification', text: 'done', submittedAt: '' }] as never });
    expect(shouldCompactByContext(settings(), notified)).toBe(true);
  });

  it('skips a harness without compaction, silently', () => {
    expect(shouldCompactByContext(settings(), session({ nativeHarness: 'gemini', provider: 'google' }))).toBe(false);
    nativeAvailableCommands.set('size-adv', [{ name: 'compress' }]);
    expect(shouldCompactByContext(settings(), session({ id: 'size-adv', nativeHarness: 'gemini', provider: 'google' }))).toBe(true);
    nativeAvailableCommands.delete('size-adv');
    expect(shouldCompactByContext(settings(), session({ nativeSessionId: undefined }))).toBe(false);
  });
});

describe('never while the worker has anything going', () => {
  const idle = { turnRunning: false, compactionStarting: false, notifications: 0, backgroundTurn: false, outOfTurn: false, vendorWorkRunning: false };
  it('is free only when nothing runs, starts or waits', () => {
    expect(workerIsBusy(idle)).toBe(false);
    for (const busy of [{ turnRunning: true }, { compactionStarting: true }, { notifications: 1 }, { backgroundTurn: true }, { outOfTurn: true }, { vendorWorkRunning: true }]) {
      expect(workerIsBusy({ ...idle, ...busy })).toBe(true);
    }
  });
});

describe('the setting', () => {
  it('reads sizes, off and default', () => {
    expect([parseCompactAt('250k'), parseCompactAt('1m'), parseCompactAt('0.5M'), parseCompactAt('300000'), parseCompactAt('off'), parseCompactAt('0'), parseCompactAt('default')])
      .toEqual([250_000, 1_000_000, 500_000, 300_000, 0, 0, undefined]);
    expect(() => parseCompactAt('10k')).toThrow('at least 50k');
    expect(() => parseCompactAt('lots')).toThrow('usage');
  });
  it('is stored on the global settings only', () => {
    const global: Record<string, unknown> = { effort: 'medium', permissionMode: 'ask' };
    applyDefaultSetting(global as never, 'compact', '300k');
    expect(global.compactAt).toBe(300_000);
    applyDefaultSetting(global as never, 'compact', 'off');
    expect(global.compactAt).toBe(0);
    applyDefaultSetting(global as never, 'compact', 'default');
    expect('compactAt' in global).toBe(false);
    expect(() => applyDefaultSetting({ model: undefined } as never, 'compact', '300k')).toThrow('unknown setting');
    expect(compactAtLabel({})).toBe('250k tokens (default)');
    expect(compactAtLabel({ compactAt: 0 })).toBe('off');
  });
});
