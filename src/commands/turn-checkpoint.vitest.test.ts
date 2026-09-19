import { describe, expect, it } from 'vitest';
import {
  beginPendingTurn, consumeSessionTurn, discardPendingTurn, enqueueSessionTurn, finishPendingTurn, recordPendingActivity, recordPendingSteer,
  sessionTranscriptMessages, updatePendingResponse,
} from './turn-checkpoint.js';
import type { HarnessSession } from './types.js';

function session(): HarnessSession {
  return {
    id: 'session', route: 'local', accountId: null, provider: 'openai', model: null,
    effort: 'medium', accountFailover: 'never', createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z', status: 'active',
    messages: [{ role: 'user', content: 'Earlier' }, { role: 'assistant', content: 'Done' }],
  };
}

describe('durable turn checkpoints', () => {
  it('makes a submitted prompt and streamed response portable before completion', () => {
    const target = session();
    beginPendingTurn(target, 'Continue the work', '2026-01-02T00:00:00.000Z');
    updatePendingResponse(target, 'Partial ', 'append', '2026-01-02T00:00:01.000Z');
    updatePendingResponse(target, 'answer', 'append', '2026-01-02T00:00:02.000Z');

    expect(sessionTranscriptMessages(target).slice(-2)).toEqual([
      { role: 'user', content: 'Continue the work' },
      { role: 'assistant', content: 'Partial answer' },
    ]);
    expect(target.messages).toHaveLength(2);
  });

  it('finalizes exactly once and clears the in-flight journal', () => {
    const target = session();
    beginPendingTurn(target, 'Continue', '2026-01-02T00:00:00.000Z');
    updatePendingResponse(target, 'Partial', 'append', '2026-01-02T00:00:01.000Z');
    finishPendingTurn(target, 'Final answer', '2026-01-02T00:00:02.000Z');

    expect(target.pendingTurn).toBeUndefined();
    expect(target.messages?.slice(-2)).toEqual([
      { role: 'user', content: 'Continue' },
      { role: 'assistant', content: 'Final answer' },
    ]);
  });

  it('retains bounded tool activity when a provider fails before prose', () => {
    const target = session();
    beginPendingTurn(target, 'Fix it', '2026-01-02T00:00:00.000Z');
    recordPendingActivity(target, { kind: 'tool-start', label: 'inspect repository' }, '2026-01-02T00:00:01.000Z');
    recordPendingActivity(target, { kind: 'tool-done', label: 'inspect repository' }, '2026-01-02T00:00:02.000Z');

    expect(sessionTranscriptMessages(target).at(-1)).toEqual({
      role: 'assistant',
      content: 'Interrupted turn activity: started inspect repository; completed inspect repository. Inspect the current workspace before continuing.',
    });
  });

  it('discards an unanswered checkpoint so Escape can restore the draft', () => {
    const target = session();
    beginPendingTurn(target, 'Edit me', '2026-01-02T00:00:00.000Z');
    expect(discardPendingTurn(target, 'Edit me')).toBe(true);
    expect(sessionTranscriptMessages(target)).toEqual(target.messages);
  });

  it('commits an older failed turn before beginning the next one', () => {
    const target = session();
    beginPendingTurn(target, 'First', '2026-01-02T00:00:00.000Z');
    updatePendingResponse(target, 'Partial', 'append', '2026-01-02T00:00:01.000Z');
    beginPendingTurn(target, 'Second', '2026-01-03T00:00:00.000Z');

    expect(target.messages?.slice(-2)).toEqual([
      { role: 'user', content: 'First' },
      { role: 'assistant', content: 'Partial' },
    ]);
    expect(target.pendingTurn?.prompt).toBe('Second');
  });

  it('preserves native steering inside the active turn transcript', () => {
    const target = session();
    beginPendingTurn(target, 'Initial request', '2026-01-02T00:00:00.000Z');
    updatePendingResponse(target, 'Before. After.', 'append', '2026-01-02T00:00:01.000Z');
    recordPendingSteer(target, 'Prioritize tests', '2026-01-02T00:00:01.000Z', 8, '2026-01-02T00:00:01.000Z');
    expect(sessionTranscriptMessages(target).slice(-4)).toEqual([
      { role: 'user', content: 'Initial request' },
      { role: 'assistant', content: 'Before. ' },
      { role: 'user', content: 'Prioritize tests' },
      { role: 'assistant', content: 'After.' },
    ]);
  });

  it('durably queues and atomically consumes a follow-up turn', () => {
    const target = session();
    const queued = { id: 'queued-1', text: '/this remains conversation text', submittedAt: '2026-01-02T00:00:00.000Z' };
    enqueueSessionTurn(target, queued, queued.submittedAt);
    enqueueSessionTurn(target, queued, queued.submittedAt);
    expect(target.queuedTurns).toEqual([queued]);
    expect(consumeSessionTurn(target, queued.id)).toBe(true);
    expect(target.queuedTurns).toBeUndefined();
  });
});
