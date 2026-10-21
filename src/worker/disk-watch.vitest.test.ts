import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { criticalBelow, diskNote, nextLevel, startDiskWatch, tightBelow, type DiskReading } from './disk-watch.js';

const GIB = 2 ** 30;
const reading = (free: number, total = 915 * GIB, device = 'a', path = '/home/u/.clikcode'): DiskReading => ({ path, device, total, free: free * GIB });

describe('disk watch levels', () => {
  it('is tight below 10% free (never under 20 GB) and critical below 3% (never under 5 GB)', () => {
    expect(tightBelow(915 * GIB) / GIB).toBeCloseTo(91.5);
    expect(tightBelow(100 * GIB) / GIB).toBe(20);
    expect(criticalBelow(915 * GIB) / GIB).toBeCloseTo(27.45);
    expect(criticalBelow(100 * GIB) / GIB).toBe(5);
    expect(nextLevel('ok', reading(139))).toBe('ok');
    expect(nextLevel('ok', reading(80))).toBe('tight');
    expect(nextLevel('ok', reading(13))).toBe('critical');
  });

  it('comes back down only once clear of a line by a margin', () => {
    expect(nextLevel('tight', reading(95))).toBe('tight');
    expect(nextLevel('tight', reading(120))).toBe('ok');
    expect(nextLevel('critical', reading(30))).toBe('critical');
    expect(nextLevel('critical', reading(40))).toBe('tight');
  });
});

describe('disk notes', () => {
  it('say how much is left and what to free, and mention Docker only where it exists', () => {
    const tight = diskNote('tight', reading(80), true);
    expect(tight).toContain('80.0 GB free of 915.0 GB (91% used) on the drive holding /home/u/.clikcode');
    expect(tight).toContain('docker rm -fv');
    expect(diskNote('tight', reading(80), false)).not.toContain('docker');
    expect(diskNote('critical', reading(13), false)).toContain('Keep working on read-only or targeted steps');
  });
});

describe('disk watch', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('tells the agent once per crossing, again only after it recovered and fell back', () => {
    const notes: string[] = [];
    let free = 139;
    const stop = startDiskWatch({ sessionId: 's', paths: ['/home/u/.clikcode'], deliver: (note) => notes.push(note), read: () => reading(free), hasDocker: false, intervalMs: 1000 });
    const step = (value: number): void => { free = value; vi.advanceTimersByTime(1000); };
    expect(notes).toEqual([]);
    step(80); expect(notes).toHaveLength(1); expect(notes[0]).toContain('getting tight');
    step(78); expect(notes).toHaveLength(1);
    step(20); expect(notes).toHaveLength(2); expect(notes[1]).toContain('almost full');
    step(30); expect(notes).toHaveLength(2);
    step(200); expect(notes).toHaveLength(2);
    step(60); expect(notes).toHaveLength(3);
    stop();
  });

  it('counts one drive once however many watched paths are on it, and each drive on its own', () => {
    const notes: string[] = [];
    const startOn = (read: (path: string) => DiskReading): (() => void) => startDiskWatch({ sessionId: 's', paths: ['/a', '/b', undefined], deliver: (note) => notes.push(note), read, hasDocker: false });
    startOn((path) => reading(50, 915 * GIB, 'same', path))();
    expect(notes).toHaveLength(1);
    startOn((path) => reading(50, 915 * GIB, path, path))();
    expect(notes).toHaveLength(3);
  });
});
