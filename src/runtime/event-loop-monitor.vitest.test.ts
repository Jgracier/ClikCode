import { describe, expect, it } from 'vitest';
import { blockedLogger } from './event-loop-monitor.js';

describe('the blocked-event-loop log', () => {
  it('writes only stalls over 100 ms, at most one per 10 s, and counts the ones it skipped into the next', () => {
    let clock = 1_000;
    const lines: Array<{ ms: number; suppressed: number }> = [];
    const note = blockedLogger((fields) => lines.push(fields), () => clock);
    note(99); note(100);
    expect(lines).toEqual([]);
    note(250.4);
    expect(lines).toEqual([{ ms: 250, suppressed: 0 }]);
    clock += 3_000; note(900);
    clock += 3_000; note(400);
    expect(lines).toHaveLength(1);
    clock += 4_000;
    note(180);
    expect(lines).toEqual([{ ms: 250, suppressed: 0 }, { ms: 180, suppressed: 2 }]);
    clock += 10_000;
    note(120);
    expect(lines.at(-1)).toEqual({ ms: 120, suppressed: 0 });
  });
});
