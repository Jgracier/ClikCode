import { describe, expect, it } from 'vitest';
import { idleDecision, startsSuccessor, vendorIdleDecision, type VendorIdleState } from './idle-decisions.js';

const HOUR = 3_600_000;

describe('a worker at its idle time', () => {
  it('exits when nothing is running', () => {
    expect(idleDecision({ workRunning: false, workSince: undefined, now: 0, ceilingMs: 24 * HOUR })).toBe('exit');
  });
  it('keeps looking while the vendor\'s background work runs', () => {
    expect(idleDecision({ workRunning: true, workSince: undefined, now: 10, ceilingMs: 24 * HOUR })).toBe('recheck');
    expect(idleDecision({ workRunning: true, workSince: 0, now: 23 * HOUR, ceilingMs: 24 * HOUR })).toBe('recheck');
  });
  it('stops the work past the ceiling', () => {
    expect(idleDecision({ workRunning: true, workSince: 0, now: 24 * HOUR, ceilingMs: 24 * HOUR })).toBe('stop-work');
  });
  it('gives a whole idle period after the work ends, not what was left of one', () => {
    expect(idleDecision({ workRunning: false, workSince: 5, now: 2 * HOUR, ceilingMs: 24 * HOUR })).toBe('fresh-idle');
  });
});

describe('a stopping worker', () => {
  it('starts a successor to deliver what the model is owed, unless someone stopped it', () => {
    expect(startsSuccessor(true, 'the work was still running 24 hours after it started, with no ClikCode window open')).toBe(true);
    expect(startsSuccessor(true, 'replaced by a newer ClikCode build')).toBe(true);
    expect(startsSuccessor(true, 'SIGTERM')).toBe(false);
    expect(startsSuccessor(true, 'SIGINT')).toBe(false);
    expect(startsSuccessor(false, 'idle timeout')).toBe(false);
  });
});

describe('a persistent vendor with no turn for a while', () => {
  const MINUTE = 60_000;
  const quiet: VendorIdleState = {
    transportOpen: true, turnRunning: false, backgroundTurn: false, vendorWork: false, pendingRequests: 0,
    idleForMs: 15 * MINUTE, closeAfterMs: 15 * MINUTE,
  };

  it('is closed once the time has passed with nothing using it, window or not', () => {
    expect(vendorIdleDecision(quiet)).toBe('close');
    expect(vendorIdleDecision({ ...quiet, idleForMs: 14 * MINUTE })).toBe('later');
  });

  it('is never closed under a turn, background work, or a question to the user', () => {
    expect(vendorIdleDecision({ ...quiet, turnRunning: true })).toBe('none');
    expect(vendorIdleDecision({ ...quiet, backgroundTurn: true })).toBe('later');
    expect(vendorIdleDecision({ ...quiet, vendorWork: true })).toBe('later');
    expect(vendorIdleDecision({ ...quiet, pendingRequests: 1 })).toBe('later');
  });

  it('has nothing to do when no vendor is open', () => {
    expect(vendorIdleDecision({ ...quiet, transportOpen: false })).toBe('none');
  });
});
