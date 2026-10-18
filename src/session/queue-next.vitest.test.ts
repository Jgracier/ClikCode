import { describe, expect, it } from 'vitest';
import { queuedNext } from './queue-next.js';

const entry = (id: string, kind?: 'command' | 'notification') => ({ id, text: id, submittedAt: '2026-10-18T00:00:00.000Z', ...(kind ? { kind } : {}) });

describe('what a window runs next from the queue', () => {
  it('runs a command, sends a message, and leaves a notification to the worker', () => {
    expect(queuedNext({ queuedTurns: [entry('c', 'command')] })?.kind).toBe('command');
    expect(queuedNext({ queuedTurns: [entry('m')] })?.kind).toBe('message');
    expect(queuedNext({ queuedTurns: [entry('n', 'notification')] })).toBeUndefined();
    expect(queuedNext({})).toBeUndefined();
  });
  it('holds messages after a Stop, but not commands', () => {
    expect(queuedNext({ queuedTurns: [entry('m')] }, { stopped: true })).toBeUndefined();
    expect(queuedNext({ queuedTurns: [entry('c', 'command')] }, { stopped: true })?.kind).toBe('command');
  });
  it('does not run again the entry that just ran and is still at the head', () => {
    expect(queuedNext({ queuedTurns: [entry('m')] }, { justRan: 'm' })).toBeUndefined();
  });
});
