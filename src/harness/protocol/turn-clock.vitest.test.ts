import { describe, expect, it } from 'vitest';
import {
  joinTurnClock, nextTurnTickMs, pauseTurnClock, resumeTurnClock, SPIN_MS, STALL_MS, startTurnClock,
  turnAnimating, turnElapsedMs, turnStalledMs,
} from './activity-view';

const idle = { toolsRunning: false, approval: false };

describe('the turn clock', () => {
  it('leaves out the time an approval waited on the user, while up and after', () => {
    const started = startTurnClock(1_000);
    const paused = pauseTurnClock(started, 4_000);
    expect(turnElapsedMs(paused, 10_000)).toBe(3_000);
    // A second pause while one is up changes nothing.
    expect(pauseTurnClock(paused, 6_000)).toBe(paused);
    const resumed = resumeTurnClock(paused, 10_000);
    expect(resumed.pausedAt).toBeUndefined();
    expect(turnElapsedMs(resumed, 12_000)).toBe(5_000);
    // Reading the approval was not a stall.
    expect(resumed.lastDataAt).toBe(10_000);
    expect(resumeTurnClock(resumed, 20_000)).toBe(resumed);
  });

  it('counts a joined turn from when it really started, never later', () => {
    const clock = startTurnClock(50_000);
    expect(turnElapsedMs(joinTurnClock(clock, 20_000), 50_000)).toBe(30_000);
    expect(joinTurnClock(clock, 60_000)).toBe(clock);
  });

  it('calls silence a stall only past STALL_MS, and never while a call runs or an approval is up', () => {
    const clock = startTurnClock(0);
    expect(turnStalledMs(clock, STALL_MS - 1, idle)).toBe(0);
    expect(turnStalledMs(clock, STALL_MS + 2_000, idle)).toBe(STALL_MS + 2_000);
    expect(turnStalledMs(clock, STALL_MS + 2_000, { toolsRunning: true, approval: false })).toBe(0);
    expect(turnStalledMs(clock, STALL_MS + 2_000, { toolsRunning: false, approval: true })).toBe(0);
  });

  it('spins while something moves and otherwise ticks just past each whole second', () => {
    const clock = startTurnClock(0);
    expect(turnAnimating(clock, 100, idle)).toBe(true);
    expect(turnAnimating(clock, STALL_MS, idle)).toBe(false);
    expect(turnAnimating(clock, STALL_MS, { toolsRunning: true, approval: false })).toBe(true);
    expect(turnAnimating(clock, 100, { toolsRunning: true, approval: true })).toBe(false);
    expect(nextTurnTickMs(clock, 100, true)).toBe(SPIN_MS);
    expect(nextTurnTickMs(clock, 16_250, false)).toBe(755);
  });
});
