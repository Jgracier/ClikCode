import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { idleServiceNote, isIdle, startIdleServices, type ServiceReading } from './idle-services.js';

const HOUR = 3_600_000;
const GIB = 2 ** 30;
const service = (over: Partial<ServiceReading> = {}): ServiceReading => ({ unit: 'web-1.service', owner: process.pid, ageMs: 28 * HOUR, held: 6.6 * GIB, cpuUsec: 1_000_000, ...over });

describe('idle service verdict', () => {
  const since = { cpuUsec: 1_000_000, at: 0 };
  it('is idle when old, large and quiet for the whole watch', () => {
    expect(isIdle(service(), since, 30 * 60_000)).toBe(true);
  });
  it('is not idle when young, small, still being watched, or busy', () => {
    expect(isIdle(service({ ageMs: 2 * HOUR }), since, 30 * 60_000)).toBe(false);
    expect(isIdle(service({ held: 50 * 2 ** 20 }), since, 30 * 60_000)).toBe(false);
    expect(isIdle(service(), since, 10 * 60_000)).toBe(false);
    expect(isIdle(service(), undefined, 30 * 60_000)).toBe(false);
    expect(isIdle(service({ cpuUsec: 1_000_000 + 60_000_000 }), since, 30 * 60_000)).toBe(false);
  });
  it('names the unit, its size and the command to stop it', () => {
    const note = idleServiceNote(service());
    expect(note).toContain('web-1.service');
    expect(note).toContain('6.6 GB');
    expect(note).toContain('systemctl --user stop web-1.service');
  });
});

describe('idle service watch', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('tells the owning agent once, and never speaks about another conversation\'s service', () => {
    const notes: string[] = [];
    let now = 0;
    const stop = startIdleServices({
      sessionId: 's', sliceDir: '/x', deliver: (note) => notes.push(note), now: () => now, intervalMs: 600_000,
      read: () => [service(), service({ unit: 'other.service', owner: process.pid + 1 })],
    });
    for (let i = 0; i < 8; i++) { now += 600_000; vi.advanceTimersByTime(600_000); }
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('web-1.service');
    stop();
  });

  it('does not tell while the service is working', () => {
    const notes: string[] = [];
    let now = 0; let cpu = 0;
    const stop = startIdleServices({
      sessionId: 's', sliceDir: '/x', deliver: (note) => notes.push(note), now: () => now, intervalMs: 600_000,
      read: () => [service({ cpuUsec: cpu })],
    });
    for (let i = 0; i < 8; i++) { now += 600_000; cpu += 120_000_000; vi.advanceTimersByTime(600_000); }
    expect(notes).toEqual([]);
    stop();
  });
});
