import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ioCandidate, ioDelta, ioNudge, ioPressure, ioStopNote, parseDiskstats, parseIoStat, startIoGuard, type Reading } from './io-guard.js';

const MIB = 2 ** 20;
const counters = (bytes: number) => new Map([['259:0', { bytes, operations: bytes / 4096 }]]);
const sample = (at: number, pressure: number, machineBytes: number, commandBytes: number, identity = '1:2'): Reading => ({
  at, pressure, machine: counters(machineBytes),
  commands: [{ path: '/owned/cmd-42', label: 'npm test', identity, counters: counters(commandBytes), stalled: 20 }],
});

afterEach(() => { vi.useRealTimers(); });

describe('disk I/O guard', () => {
  it('parses pressure and per-device I/O counters, ignoring resets', () => {
    expect(ioPressure('some avg10=20.00\nfull avg10=15.25 avg60=1.00')).toBe(15.25);
    expect(ioPressure('some avg10=20.00')).toBeUndefined();
    const before = parseIoStat('259:0 rbytes=1048576 wbytes=0 rios=200 wios=0\n');
    const after = parseIoStat('259:0 rbytes=2097152 wbytes=1048576 rios=400 wios=200\n');
    expect(ioDelta(before, after).get('259:0')).toEqual({ bytes: 2 * MIB, operations: 400 });
    expect(ioDelta(after, before).size).toBe(0);
    expect(parseDiskstats(' 259 0 nvme0n1 10 0 100 0 20 0 200 0 0 0 0').get('259:0'))
      .toEqual({ bytes: 300 * 512, operations: 30 });
  });

  it('warns without stopping when other work dominates the disk', () => {
    vi.useFakeTimers();
    const notes: string[] = [];
    let index = 0;
    const readings = Array.from({ length: 8 }, (_, i) => sample(1_000 + i * 5_000, 25, i * 100 * MIB, i * 10 * MIB));
    const stop = vi.fn(() => true);
    const close = startIoGuard({ sessionId: 'other-work', scopeDir: '/unused', labels: new Map(), read: () => readings[index++],
      now: () => Date.now(), stop, deliver: (note) => notes.push(note) });
    try {
      vi.advanceTimersByTime(40_000);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain('has not identified your command as the cause');
      expect(stop).not.toHaveBeenCalled();
    } finally { close(); }
  });

  it('selects an owned issuer only when it dominates machine I/O', () => {
    const first = sample(1_000, 20, 0, 0);
    const owned = ioCandidate(first, sample(6_000, 20, 100 * MIB, 60 * MIB));
    // 12 MiB/s is below the byte threshold but enough small I/Os to qualify.
    expect(owned?.machineShare).toBe(0.6);
    expect(ioNudge(owned!, 20)).toContain('npm test');
    expect(ioStopNote(owned!, 20)).toContain('do not rerun');
    expect(ioCandidate(first, sample(6_000, 20, 100 * MIB, 10 * MIB))).toBeUndefined();
    expect(ioCandidate(first, sample(6_000, 20, 100 * MIB, 60 * MIB, '1:3'))).toBeUndefined();
    expect(ioCandidate(first, sample(6_000, 20, 20 * MIB, 60 * MIB))).toBeUndefined();
    const waitingElsewhere = sample(6_000, 20, 100 * MIB, 60 * MIB);
    waitingElsewhere.commands[0]!.stalled = 0;
    expect(ioCandidate(first, waitingElsewhere)).toBeUndefined();
  });

  it('warns, stops one owned group after sustained stalls, and avoids repeat stops when pressure stays high', () => {
    vi.useFakeTimers();
    const home = mkdtempSync(join(tmpdir(), 'clikcode-io-guard-'));
    const oldHome = process.env.CLIKCODE_HOME;
    process.env.CLIKCODE_HOME = home;
    const group = join(home, 'cmd-42');
    mkdirSync(group);
    writeFileSync(join(group, 'cgroup.procs'), '42\n');
    const stat = statSync(group);
    const identity = `${stat.dev}:${stat.ino}`;
    const notes: string[] = [];
    const stopped: string[] = [];
    let index = 0;
    const readings = [
      sample(1_000, 20, 0, 0, identity),
      sample(6_000, 20, 100 * MIB, 60 * MIB, identity),
      sample(11_000, 20, 200 * MIB, 120 * MIB, identity),
      sample(16_000, 20, 300 * MIB, 180 * MIB, identity),
      sample(21_000, 20, 400 * MIB, 240 * MIB, identity),
      sample(26_000, 20, 500 * MIB, 300 * MIB, identity),
      ...Array.from({ length: 13 }, (_, i) => sample(31_000 + i * 5_000, 18, (600 + i * 100) * MIB, (360 + i * 60) * MIB, identity)),
    ].map((reading) => ({ ...reading, commands: reading.commands.map((command) => ({ ...command, path: group })) }));
    const stopGuard = startIoGuard({
      sessionId: 'test', scopeDir: '/unused', labels: new Map(),
      read: () => readings[index++], now: () => 1_000,
      stop: (path) => { stopped.push(path); return true; }, deliver: (note) => notes.push(note),
    });
    try {
      vi.advanceTimersByTime(90_000);
      expect(notes).toHaveLength(2);
      expect(notes[0]).toContain('Disk I/O is stalling');
      expect(notes[1]).toContain('ClikCode stopped');
      expect(stopped).toEqual([group]);
      expect(existsSync(join(home, 'io-guard.ineffective'))).toBe(true);
    } finally {
      stopGuard();
      if (oldHome === undefined) delete process.env.CLIKCODE_HOME; else process.env.CLIKCODE_HOME = oldHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
