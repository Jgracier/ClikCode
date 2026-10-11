import { describe, expect, it } from 'vitest';
import { turnEndLine } from './turn-end-line';
import { finishPendingTurn } from '../../turn/checkpoint';
import type { HarnessSession } from '../../session/model';

const call = (id: string, extra: Record<string, unknown> = {}) => ({ event: { kind: 'tool-done' as const, label: 'Bash', id, ...extra }, responseOffset: 0 });

describe('the line a saved turn ends on', () => {
  it('says how long a turn that ran a tool worked, from the answer it ended on', () => {
    const messages = [
      { role: 'user' as const, content: 'check' },
      { role: 'assistant' as const, content: 'Done.', activities: [call('a')], turnEnd: { ms: 4_000 } },
    ];
    expect(turnEndLine(messages, 1)).toBe('Worked for 4s');
    expect(turnEndLine(messages, 0)).toBeUndefined();
  });

  it('counts the calls of every answer a steer split the turn into', () => {
    const messages = [
      { role: 'user' as const, content: 'check' },
      { role: 'assistant' as const, content: 'First.', activities: [call('a')] },
      { role: 'user' as const, content: 'also this', id: 'steer-1' },
      { role: 'assistant' as const, content: 'Second.', turnEnd: { ms: 2_000 } },
    ];
    expect(turnEndLine(messages, 3)).toBe('Worked for 2s');
  });

  it('draws nothing for a quick answer that called nothing', () => {
    expect(turnEndLine([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hello.', turnEnd: { ms: 900 } }], 1)).toBeUndefined();
  });

  it('adds what the turn spent where the harness reported it: tokens and cost, in the extension\'s words', () => {
    const messages = [
      { role: 'user' as const, content: 'check' },
      { role: 'assistant' as const, content: 'Done.', activities: [call('a')], turnEnd: { ms: 4_000, usage: { input: 1_200, output: 340, cacheRead: 37_000, contextUsed: 20_000, costUsd: 0.0231 } } },
    ];
    expect(turnEndLine(messages, 1)).toBe('Worked for 4s · ↑ 1.2k ↓ 340 tokens · $0.02');
  });

  it('says it is waiting for background agents, even for a quick answer', () => {
    const quick = [{ role: 'user' as const, content: 'go' }, { role: 'assistant' as const, content: 'Launched.', turnEnd: { ms: 900, pendingBackground: 2 } }];
    expect(turnEndLine(quick as never, 1)).toBe('Waiting for 2 background agents');
  });

  it('says a stopped turn stopped, however short', () => {
    expect(turnEndLine([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hel', turnEnd: { ms: 900, stopped: true } }], 1)).toBe('Stopped after 1s');
  });
});

describe('committing a turn', () => {
  const session = (): HarnessSession => ({
    id: 's', route: 'local', accountId: null, provider: null, model: null, createdAt: '', updatedAt: '', status: 'active',
    messages: [], pendingTurn: { prompt: 'check', response: 'Done.', startedAt: '2026-10-09T10:00:00.000Z', updatedAt: '2026-10-09T10:00:00.000Z', outputStarted: true },
  } as HarnessSession);

  it('stamps the answer it ended on with how long it took', () => {
    const finished = session();
    finishPendingTurn(finished, undefined, '2026-10-09T10:00:12.000Z');
    expect(finished.messages?.at(-1)?.turnEnd).toEqual({ ms: 12_000 });
  });

  it('carries the usage this turn reported, and not a previous turn\'s', () => {
    const fresh = session();
    fresh.lastUsage = { output: 340, costUsd: 0.02, at: '2026-10-09T10:00:05.000Z' };
    finishPendingTurn(fresh, undefined, '2026-10-09T10:00:12.000Z');
    expect(fresh.messages?.at(-1)?.turnEnd).toEqual({ ms: 12_000, usage: { output: 340, costUsd: 0.02 } });
    const stale = session();
    stale.lastUsage = { output: 999, at: '2026-10-09T09:00:00.000Z' };
    finishPendingTurn(stale, undefined, '2026-10-09T10:00:12.000Z');
    expect(stale.messages?.at(-1)?.turnEnd).toEqual({ ms: 12_000 });
  });

  it('marks a stopped one as stopped', () => {
    const stopped = session();
    finishPendingTurn(stopped, undefined, '2026-10-09T10:00:03.000Z', true);
    expect(stopped.messages?.at(-1)?.turnEnd).toEqual({ ms: 3_000, stopped: true });
  });
});
