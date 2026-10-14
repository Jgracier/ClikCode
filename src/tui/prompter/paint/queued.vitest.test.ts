import { describe, expect, it } from 'vitest';
import type { TerminalHarnessPrompter } from '../../prompter.js';
import type { HarnessSession } from '../../../session/model.js';
import { queuedMessageRows, queuedMessagesOf } from './queued.js';

const fake = (waiting: unknown[] = [], takingBack: string[] = []) => ({
  waitingSubmissions: waiting, takingBack: new Set(takingBack),
  turn: { sendWaiting: () => undefined, takeBack: async () => 'removed', cancelled: false, draft: '' },
}) as unknown as TerminalHarnessPrompter;
const session = (queued: Array<{ id: string; text: string; submittedAt?: string }>): HarnessSession =>
  ({ queuedTurns: queued.map((item) => ({ submittedAt: '2026-01-01T00:00:00Z', ...item })) }) as unknown as HarnessSession;

describe('queued rows are drawn once', () => {
  it('drops a stored row that is also a steer, by id', () => {
    const pending = { steers: [{ id: 'q1', text: 'yes', submittedAt: '' }] } as unknown as HarnessSession['pendingTurn'];
    expect(queuedMessagesOf(fake(), session([{ id: 'q1', text: 'yes' }, { id: 'q2', text: 'yes' }]), pending).queuedMessages).toHaveLength(1);
  });

  it('drops a stored row that became the running turn, but not one queued during it', () => {
    const pending = { prompt: 'next', startedAt: '2026-01-01T00:00:05Z', steers: [] } as unknown as HarnessSession['pendingTurn'];
    const rows = queuedMessagesOf(fake(), session([{ id: 'a', text: 'next' }, { id: 'b', text: 'next', submittedAt: '2026-01-01T00:00:09Z' }]), pending, { steers: [], prompt: 'next' });
    expect(rows.queuedMessages).toHaveLength(1);
  });

  it('keeps the bottom row of a sending steer until its own row is built', () => {
    const waiting = [{ localId: 1, text: 'yes', sequence: 1, responseOffset: 0, state: 'sending' }];
    const pending = { steers: [{ id: 'm1', text: 'yes', submittedAt: '' }] } as unknown as HarnessSession['pendingTurn'];
    expect(queuedMessagesOf(fake(waiting), session([]), pending, { steers: [] }).queuedMessages).toHaveLength(1);
    expect(queuedMessagesOf(fake(waiting), session([]), pending, { steers: [{ text: 'yes', steerId: 'm1' }] }).queuedMessages).toHaveLength(0);
  });

  it('hides a message being taken back', () => {
    expect(queuedMessagesOf(fake([], ['a']), session([{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }]), undefined).queuedMessages.map((m) => m.content)).toEqual(['y']);
  });

  it('says what each waiting message is waiting for', () => {
    const { queuedMessages, enterAt, escAt } = queuedMessagesOf(fake(), session([{ id: 'a', text: 'x' }]), undefined);
    const text = queuedMessageRows(queuedMessages, enterAt, escAt, 120, (c) => [c]).join('\n');
    expect(text).toContain('queued for next turn');
    expect(text).toContain('esc edit');
  });
});
