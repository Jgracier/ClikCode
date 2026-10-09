/** A stopped turn reads as stopped, not finished: the calls still open when
 * it was stopped are closed as stopped in the saved turn (the durable copy
 * every window and a reopened chat draw from), their rows say so, and the
 * line the turn ends on says "Stopped after". */
import { describe, expect, it } from 'vitest';
import { renderActivityLine } from '../harness/protocol/activity-line.js';
import { activityOutcome, stoppedCall } from '../harness/protocol/activity-view.js';
import { turnSummary } from '../harness/protocol/turn-flow.js';
import type { HarnessSession } from '../session/model.js';
import { stopEntries, upsertActivityEvent } from '../tui/render/activity-log.js';
import { beginPendingTurn, finishPendingTurn, recordPendingActivity, sessionTranscriptMessages, stopPendingCalls } from './checkpoint.js';
import { activityTextSummary, readTurnActivities } from './turn-activities.js';

const plain = (rows: string[]): string[] => rows.map((row) => row.replace(/\u001b\[[0-9;]*m/g, '').trim());
const now = '2026-10-09T00:00:00.000Z';

function session(): HarnessSession {
  return {
    id: 's', route: 'local', accountId: null, provider: 'openai', model: null, effort: 'medium',
    createdAt: now, updatedAt: now, status: 'active', messages: [],
  };
}

describe('a turn stopped with calls still open', () => {
  it('saves them stopped, and leaves finished ones as they were', () => {
    const chat = session();
    beginPendingTurn(chat, 'run it', now);
    recordPendingActivity(chat, { kind: 'tool-start', id: 'a', label: '$ ls', category: 'run' }, now);
    recordPendingActivity(chat, { kind: 'tool-done', id: 'a', label: '$ ls', category: 'run' }, now);
    recordPendingActivity(chat, { kind: 'tool-start', id: 'b', label: '$ sleep 30', category: 'run' }, now);
    recordPendingActivity(chat, { kind: 'tool-start', id: 'c', label: 'Agent worker 0', agent: true }, now);
    stopPendingCalls(chat);
    finishPendingTurn(chat, undefined, now);
    const saved = readTurnActivities(chat.messages!.at(-1)!.activities).map((activity) => activity.event);
    expect(saved.map((event) => [event.id, event.kind, event.stopped ?? false])).toEqual([
      ['a', 'tool-done', false], ['b', 'tool-error', true], ['c', 'tool-error', true],
    ]);
    // Reopened, the same rows: the saved record is what is drawn.
    expect(sessionTranscriptMessages(chat).at(-1)!.activities).toEqual(chat.messages!.at(-1)!.activities);
    expect(activityTextSummary(readTurnActivities(chat.messages!.at(-1)!.activities))).toBe('Tool calls: $ ls; $ sleep 30 (stopped); Agent worker 0 (stopped).');
  });

  it('draws a stopped call with its own glyph and word, not the finished glyph or a failure', () => {
    const row = plain(renderActivityLine(stoppedCall({ kind: 'tool-start', label: '$ sleep 30', category: 'run' })))[0];
    expect(row).toBe('■ $ sleep 30 stopped');
    expect(plain(renderActivityLine({ kind: 'tool-done', label: '$ sleep 30', category: 'run' }))[0]).not.toContain('■');
    expect(activityOutcome({ ...stoppedCall({ kind: 'tool-start' as const }), durationMs: 4000 })?.failed).toBe(false);
  });

  it('stops only the open rows the turn is asked about, re-rendered', () => {
    let entries = upsertActivityEvent([], 0, 0, { kind: 'tool-start', id: 'x', label: '$ sleep 30', category: 'run' }, 1);
    entries = upsertActivityEvent(entries, 0, 0, { kind: 'tool-done', id: 'y', label: '$ ls', category: 'run' }, 2);
    const stopped = stopEntries(entries, () => true);
    expect(stopped.map((entry) => entry.event?.kind)).toEqual(['tool-error', 'tool-done']);
    expect(plain(stopped[0]!.lines)).toEqual(['■ $ sleep 30 stopped']);
    expect(stopEntries(stopped, () => true)).toBe(stopped);
    expect(stopEntries(entries, () => false)).toBe(entries);
  });

  it('ends on "Stopped after", where a finished turn says "Worked for"', () => {
    expect(turnSummary({ ms: 4200, stopped: true })).toBe('Stopped after 4s');
    expect(turnSummary({ ms: 4200 })).toBe('Worked for 4s');
  });
});
