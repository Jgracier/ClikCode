import { describe, expect, it } from 'vitest';
import { conversationState, SECTION_TITLES, turnActiveAt, turnFacts } from './conversation-state';

const NOW = Date.parse('2026-09-29T12:00:00');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MINUTE = 60_000;

describe('a conversation row\'s one state', () => {
  it('is how long a running turn has been working', () => {
    expect(conversationState({ updatedAt: ago(0), turn: { startedAt: ago(3 * MINUTE), activeAt: ago(10_000) } }, NOW))
      .toEqual({ kind: 'working', text: 'working 3m' });
  });

  it('counts the agents a working turn has out', () => {
    expect(conversationState({ updatedAt: ago(0), turn: { startedAt: ago(3 * MINUTE), activeAt: ago(0), agents: 2 } }, NOW).text)
      .toBe('working 3m · 2 agents');
    expect(conversationState({ updatedAt: ago(0), turn: { startedAt: ago(3 * MINUTE), activeAt: ago(0), agents: 1 } }, NOW).text)
      .toBe('working 3m · 1 agent');
  });

  it('is stalled, and for how long, once the turn has been quiet three minutes', () => {
    expect(conversationState({ updatedAt: ago(0), turn: { startedAt: ago(20 * MINUTE), activeAt: ago(4 * MINUTE), agents: 2 } }, NOW))
      .toEqual({ kind: 'stalled', text: 'stalled 4m' });
  });

  it('shows idle when no turn facts are passed (conversationRows filtered them out)', () => {
    // conversationRows only passes turn facts when activity === 'working', which
    // requires a live worker. So if turn is undefined, show the updatedAt time.
    expect(conversationState({ updatedAt: ago(4 * MINUTE) }, NOW))
      .toEqual({ kind: 'idle', text: '4m ago' });
  });

  it('needs you while an approval waits, over everything else', () => {
    expect(conversationState({
      updatedAt: ago(0), needsYou: true, turn: { startedAt: ago(20 * MINUTE), activeAt: ago(10 * MINUTE) }, resumeAt: ago(-MINUTE),
    }, NOW)).toEqual({ kind: 'needs-you', text: 'needs you' });
  });

  it('says when a turn parked for the quota reset is back', () => {
    const at = new Date('2026-09-29T14:30:00').toISOString();
    expect(conversationState({ updatedAt: ago(5 * MINUTE), resumeAt: at }, NOW)).toEqual({ kind: 'back', text: 'back 2:30PM' });
  });

  it('is otherwise how long ago it last changed', () => {
    expect(conversationState({ updatedAt: ago(5 * MINUTE) }, NOW)).toEqual({ kind: 'idle', text: '5m ago' });
    expect(conversationState({ updatedAt: ago(5 * MINUTE), resumeAt: 'not a date' }, NOW).kind).toBe('idle');
  });

  it('never calls a turn with no readable timestamps stalled', () => {
    expect(conversationState({ updatedAt: ago(0), turn: { startedAt: '', activeAt: '' } }, NOW)).toEqual({ kind: 'working', text: 'working' });
  });
});

describe('a running turn\'s facts', () => {
  it('count a sub-agent\'s step as the turn doing something', () => {
    const pending = {
      startedAt: ago(20 * MINUTE), updatedAt: ago(10 * MINUTE),
      subagents: [{ startedAt: ago(9 * MINUTE), stepAt: ago(20_000) }, { startedAt: ago(5 * MINUTE) }],
    };
    expect(turnActiveAt(pending)).toBe(ago(20_000));
    expect(turnFacts(pending)).toEqual({ startedAt: ago(20 * MINUTE), activeAt: ago(20_000), agents: 2 });
    expect(conversationState({ updatedAt: ago(0), turn: turnFacts(pending) }, NOW).kind).toBe('working');
    expect(turnFacts({ startedAt: ago(MINUTE), updatedAt: ago(0) })).toEqual({ startedAt: ago(MINUTE), activeAt: ago(0) });
  });
});

describe('the sections', () => {
  it('are Working, Recent and Older, without counts', () => {
    expect(Object.values(SECTION_TITLES)).toEqual(['Working', 'Recent', 'Older']);
  });
});
