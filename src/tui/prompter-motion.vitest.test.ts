/** The turn's motion: the glyph and the label shimmer step on one fast clock,
 * and stand still whenever the turn waits on the user or motion is reduced. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTurnTickMs, startTurnClock, turnAnimating } from '../harness/protocol/activity-view.js';
import { SHIMMER_STRIDE, SPIN_MS, shimmerCycleMs, SHIMMER_WIDTH } from '../harness/protocol/timings.js';
import { shimmerLevels } from '../harness/protocol/turn-flow.js';
import { TerminalHarnessPrompter } from './prompter.js';

const strip = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');

describe('the cadence constants', () => {
  it('steps the glyph at most every 120 ms and the shimmer one cell per step', () => {
    expect(SPIN_MS).toBeLessThanOrEqual(120);
    expect(SHIMMER_STRIDE).toBe(1);
    // One sweep: every cell of the label plus the band either side, a cell a step.
    expect(shimmerCycleMs(10)).toBe((10 + SHIMMER_WIDTH * 2) * SPIN_MS);
    // Consecutive steps move the highlight exactly one cell.
    const centre = (frame: number): number => shimmerLevels(30, frame * SHIMMER_STRIDE).indexOf(1);
    expect(centre(12) - centre(11)).toBe(1);
  });

  it('ticks once a second, not at the spinner step, while the turn waits on the user', () => {
    const clock = startTurnClock(0);
    expect(nextTurnTickMs(clock, 100, turnAnimating({ toolsRunning: false, approval: false }))).toBe(SPIN_MS);
    const blocked = nextTurnTickMs(clock, 100, turnAnimating({ toolsRunning: true, approval: true }));
    expect(blocked).toBeGreaterThan(800);
  });
});

const realTty = process.stdout.isTTY;
const realWrite = process.stdout.write.bind(process.stdout);
const realMotion = process.env.CLIKCODE_REDUCED_MOTION;

function open(): { rl: TerminalHarnessPrompter; line: () => string; frame: () => number } {
  Object.assign(process.stdout, { isTTY: true, columns: 100, rows: 40 });
  process.stdout.write = (() => true) as typeof process.stdout.write;
  const rl = new TerminalHarnessPrompter();
  rl.startWaiting('thinking', () => undefined, async () => ({ kind: 'sent' }) as never);
  const inner = rl as unknown as { turn: unknown; waitingLine(turn: unknown, width: number): string; waitingFrame: number };
  return { rl, line: () => strip(inner.waitingLine(inner.turn, 100)), frame: () => inner.waitingFrame };
}

describe('the status line motion', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); delete process.env.CLIKCODE_REDUCED_MOTION; });
  afterEach(() => {
    vi.useRealTimers();
    Object.assign(process.stdout, { isTTY: realTty });
    process.stdout.write = realWrite;
    if (realMotion === undefined) delete process.env.CLIKCODE_REDUCED_MOTION; else process.env.CLIKCODE_REDUCED_MOTION = realMotion;
  });

  it('advances the shared frame at the spinner step', () => {
    const { rl, frame } = open();
    try {
      const start = frame();
      vi.advanceTimersByTime(SPIN_MS * 10 + 1);
      expect(frame() - start).toBe(10);
    } finally { rl.close(); }
  });

  it('holds the frame still under reduced motion', () => {
    process.env.CLIKCODE_REDUCED_MOTION = '1';
    const { rl, frame } = open();
    try {
      vi.advanceTimersByTime(SPIN_MS * 10 + 1);
      expect(frame()).toBe(0);
    } finally { rl.close(); }
  });

  it('holds the frame still, with a dot and no clock, while an approval waits', () => {
    const { rl, frame, line } = open();
    try {
      void rl.approval('Run make?', 'make clean');
      vi.advanceTimersByTime(250);
      const held = frame();
      vi.advanceTimersByTime(SPIN_MS * 10);
      expect(frame()).toBe(held);
      expect(line()).toContain('● waiting for you');
    } finally { rl.close(); }
  });
});
