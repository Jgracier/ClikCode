import { describe, expect, it } from 'vitest';
import { ACTIVE_WITHIN_MS, conversationRows, recencySection } from './conversation-rows';
import type { HarnessSession } from './model';

const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const HOUR = 60 * 60 * 1000;

function chat(id: string, overrides: Partial<HarnessSession> = {}): HarnessSession {
  return {
    id, conversationId: id, route: 'local', accountId: null, provider: null, model: null,
    effort: 'medium', permissionMode: 'ask', createdAt: ago(100 * HOUR), updatedAt: ago(HOUR), status: 'active', ...overrides,
  } as HarnessSession;
}

describe('conversationRows: the one list both surfaces draw', () => {
  const turn = { prompt: 'go', startedAt: ago(5_000), updatedAt: ago(1_000), outputStarted: true };

  it('is Working, then Recent (24h), then Older, newest first in each', () => {
    const rows = conversationRows([
      chat('past-new', { updatedAt: ago(30 * HOUR) }),
      chat('past-old', { updatedAt: ago(90 * HOUR) }),
      chat('active', { updatedAt: ago(2 * HOUR) }),
      chat('busy', { updatedAt: ago(80 * HOUR) }),
    ], { workerIsLive: (id) => id === 'busy', pending: new Map([['busy', turn]]), now: NOW });
    expect(rows.map((row) => [row.latest.id, row.section])).toEqual([
      ['busy', 'working'], ['active', 'active'], ['past-new', 'past'], ['past-old', 'past'],
    ]);
    expect(rows[0]?.pending).toEqual(turn);
  });

  it('puts a conversation that needs the user first within its section', () => {
    const rows = conversationRows([
      chat('busy-new', { updatedAt: ago(1_000) }),
      chat('busy-asking', { updatedAt: ago(10 * HOUR) }),
      chat('recent'),
    ], {
      workerIsLive: (id) => id.startsWith('busy'), awaitingYou: (id) => id === 'busy-asking',
      pending: new Map([['busy-new', turn], ['busy-asking', turn]]), now: NOW,
    });
    expect(rows.map((row) => [row.latest.id, row.needsYou])).toEqual([['busy-asking', true], ['busy-new', false], ['recent', false]]);
  });

  it('is one row per conversation, opening its newest open chat, working if any chat generates', () => {
    const rows = conversationRows([
      chat('first', { conversationId: 'root', updatedAt: ago(3 * HOUR) }),
      chat('handoff', { conversationId: 'root', parentSessionId: 'first', updatedAt: ago(HOUR) }),
      chat('closed-newer', { conversationId: 'root', status: 'closed', updatedAt: ago(1_000) }),
    ], { workerIsLive: (id) => id === 'first', pending: new Map([['first', turn]]), now: NOW, currentId: 'first' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ root: 'root', section: 'working', activity: 'working', current: true });
    expect(rows[0]?.latest.id).toBe('handoff');
    expect(rows[0]?.updatedAtMs).toBe(NOW - 1_000);
  });

  it('is not working on a transcript turn with no worker behind it (a crash)', () => {
    const rows = conversationRows([chat('crashed')], { pending: new Map([['crashed', turn]]), now: NOW });
    expect(rows[0]).toMatchObject({ section: 'active' });
    expect(rows[0]?.activity).toBeUndefined();
  });

  it('marks the chat open here idle, leaves clerks out, and ignores a stored listTurn', () => {
    const old = chat('old', { updatedAt: ago(48 * HOUR) });
    (old as { listTurn?: unknown }).listTurn = { startedAt: ago(48 * HOUR), prompt: 'go' };
    const rows = conversationRows([old, chat('clerk', { clerkOf: 'old' })], { workerIsLive: () => true, now: NOW, currentId: 'old' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ activity: 'idle', section: 'past', current: true });
  });

  it('cuts Active at 24 hours', () => {
    expect(recencySection(NOW - ACTIVE_WITHIN_MS + 1, NOW)).toBe('active');
    expect(recencySection(NOW - ACTIVE_WITHIN_MS, NOW)).toBe('past');
    expect(recencySection(undefined, NOW)).toBe('past');
  });
});
