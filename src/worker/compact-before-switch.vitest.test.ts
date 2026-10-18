import { describe, expect, it } from 'vitest';
import { shouldCompactBeforeSwitch, noteCompacted, COMPACT_ABOVE_TOKENS } from './compact-before-switch.js';
import { canCompact, compactCommand } from '../tui/slash/compact.js';
import { nativeAvailableCommands } from '../turn/vendor-process.js';
import type { HarnessSession, HarnessState } from '../session/model.js';

const now = Date.parse('2026-10-18T12:00:00.000Z');
const account = (id: string, used: number) => ({
  id, provider: 'anthropic', label: id, status: 'ready', authKind: 'vendor-cli', models: ['opus'],
  usage: { at: '2026-10-18T11:59:00.000Z', windows: [{ name: '5h', usedPct: used, resetsAt: '2026-10-18T14:00:00.000Z' }] },
});
const session = (over: Partial<HarnessSession> = {}): HarnessSession => ({
  id: `s-${Math.random()}`, route: 'local', provider: 'anthropic', nativeHarness: 'claude', accountId: 'a', nativeSessionId: 'n1',
  model: 'opus', effort: 'medium', status: 'active', createdAt: '', updatedAt: '', messages: [{ role: 'user', content: 'hi' }],
  lastUsage: { contextUsed: 700_000, at: '' }, ...over,
} as HarnessSession);
const state = (...accounts: ReturnType<typeof account>[]): HarnessState => ({ accounts, sessions: [] } as unknown as HarnessState);

describe('compacting a large conversation before its account runs out', () => {
  it('compacts when the account is nearly out, the conversation is large, and another account would take over', () => {
    expect(shouldCompactBeforeSwitch(state(account('a', 96), account('b', 10)), session(), account('a', 96) as never, now)).toBe(true);
  });
  it('waits while the account has room, the conversation is small, or nothing would take over', () => {
    expect(shouldCompactBeforeSwitch(state(account('a', 80), account('b', 10)), session(), account('a', 80) as never, now)).toBe(false);
    expect(shouldCompactBeforeSwitch(state(account('a', 96), account('b', 10)), session({ lastUsage: { contextUsed: COMPACT_ABOVE_TOKENS - 1, at: '' } as never }), account('a', 96) as never, now)).toBe(false);
    expect(shouldCompactBeforeSwitch(state(account('a', 96)), session(), account('a', 96) as never, now)).toBe(false);
  });
  it('never goes ahead of a message the user queued, and is not retried every turn', () => {
    const queued = session({ queuedTurns: [{ id: 'q', text: 'next', submittedAt: '' }] });
    expect(shouldCompactBeforeSwitch(state(account('a', 96), account('b', 10)), queued, account('a', 96) as never, now)).toBe(false);
    const once = session();
    noteCompacted(once.id, now);
    expect(shouldCompactBeforeSwitch(state(account('a', 96), account('b', 10)), once, account('a', 96) as never, now + 60_000)).toBe(false);
  });
});

describe('which harnesses can compact', () => {
  it('Claude by its own /compact; an ACP agent by the compaction command it advertised; others not at all', () => {
    expect(compactCommand('c', session())).toBe('/compact');
    const gemini = session({ id: 'g', nativeHarness: 'gemini', provider: 'google' });
    expect(canCompact('g', gemini)).toBe(false);
    nativeAvailableCommands.set('g', [{ name: 'compress' }]);
    expect(compactCommand('g', gemini)).toBe('/compress');
    expect(canCompact('g', gemini)).toBe(true);
    nativeAvailableCommands.delete('g');
    expect(canCompact('x', session({ id: 'x', nativeSessionId: undefined }))).toBe(false);
  });
});
