/** A window that joins a running turn draws what an attached one draws, in
 * the same order (standard 11), from what the worker's snapshot carries. */
import { describe, expect, it } from 'vitest';
import { drawJoinedTurn, type JoinedTurn, type JoinedTurnSurface } from './joined-turn.js';
import type { TurnMark } from '../session/model.js';

function surface(): JoinedTurnSurface & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    response: (text, mode) => { calls.push(`response:${mode}:${text.length}`); },
    activityEvent: (event, live) => { calls.push(`activity:${event.id}@${live?.responseOffset}`); },
    joinMark: (mark) => { calls.push(`mark:${mark.id}@${mark.responseOffset}`); },
    joinThought: (thought) => { calls.push(`thought:${thought.id}`); },
    setPlan: (entries) => { calls.push(`plan:${entries.length}`); },
    phase: (message) => { calls.push(`phase:${message}`); },
    setTurnUsage: () => { calls.push('usage'); },
    setBackgroundWork: (work) => { calls.push(`background:${work?.terminals ?? 0}`); },
  };
}
const thought = (id: string, seq: number, responseOffset: number): TurnMark => ({ kind: 'thought', id, seq, responseOffset, durationMs: 3000 });
const call = (id: string, seq: number, responseOffset: number) => ({ event: { kind: 'tool-done' as const, label: id, id, seq }, responseOffset });
const base = (extra: Partial<JoinedTurn>): JoinedTurn => ({ liveText: 'Looking. Found it.', activities: [], plan: [], marks: [], ...extra });

describe('drawing a joined turn', () => {
  it('draws settled thoughts, notices and calls in (offset, seq) order, then the open thought, phase and usage', () => {
    const rl = surface();
    drawJoinedTurn(rl, base({
      activities: [call('a', 2, 9), call('b', 5, 9)],
      marks: [thought('t1', 1, 0), { kind: 'notice', id: 'n', seq: 3, responseOffset: 9, message: 'Switched' }, thought('t2', 6, 9)],
      thought: { id: 'open', text: '**Checking** the cache', seq: 7, responseOffset: 18, startedAt: 1000 },
      plan: [{ content: 'one', status: 'pending' }], phase: 'thinking', usage: { output: 12 } as never,
    }));
    expect(rl.calls).toEqual([
      'response:replace:18', 'mark:t1@0', 'activity:a@9', 'mark:n@9', 'activity:b@9', 'mark:t2@9',
      'thought:open', 'plan:1', 'phase:thinking', 'usage',
    ]);
  });

  it('keeps arrival order when a mark has no worker seq, never comparing it with one that has', () => {
    const rl = surface();
    drawJoinedTurn(rl, base({
      activities: [call('a', 9, 4)],
      // A decision learned from request-closed carries no seq: it was here
      // after everything the worker had numbered at its offset.
      marks: [{ ...thought('t1', 1, 4) }, { kind: 'outcome', id: 'o', seq: 0, responseOffset: 4, outcome: 'approved', label: 'make' }],
      unsequenced: ['o'],
    }));
    expect(rl.calls.slice(1)).toEqual(['activity:a@4', 'mark:t1@4', 'mark:o@4']);
  });

  it('does not restore an approval wait as the status', () => {
    const rl = surface();
    drawJoinedTurn(rl, base({ phase: 'waiting for your approval: make clean' }));
    expect(rl.calls.some((call) => call.startsWith('phase'))).toBe(false);
  });

  it('draws the background terminals the turn had running, last', () => {
    const rl = surface();
    drawJoinedTurn(rl, base({ usage: { output: 12 } as never, background: { agents: 1, terminals: 2 } }));
    expect(rl.calls.slice(-2)).toEqual(['usage', 'background:2']);
  });
});
