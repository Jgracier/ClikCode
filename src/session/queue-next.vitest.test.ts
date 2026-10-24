import { describe, expect, it } from 'vitest';
import { queuedNext, turnNeedsWindow } from './queue-next.js';

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

describe('turnNeedsWindow: what only a window can prepare before a turn', () => {
  it('is true for a ClikCode Local model and for an account that must sign in on a screen', () => {
    expect(turnNeedsWindow({ route: 'clikcode-local' }, [])).toBe(true);
    expect(turnNeedsWindow({ route: 'local', nativeHarness: 'claude', accountId: 'a' }, [{ id: 'a', status: 'needs_login' }])).toBe(true);
  });
  it('is false for the Gateway, ClikCode\'s agent and a signed-in vendor harness', () => {
    expect(turnNeedsWindow({ route: 'gateway' }, [])).toBe(false);
    expect(turnNeedsWindow({ route: 'local', nativeHarness: 'claude', accountId: 'a' }, [{ id: 'a', status: 'available' }])).toBe(false);
    expect(turnNeedsWindow({ route: 'local', accountId: 'a' }, [{ id: 'a', status: 'needs_login' }])).toBe(false);
  });
});
