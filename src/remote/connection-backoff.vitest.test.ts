/** A machine that does not answer is tried ever less often, and at once on a user action or a network change. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { RemoteLink } from './connection.js';
import { newMachineRecord } from './machines.js';

class DeadHost extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  constructor() { super(); queueMicrotask(() => { this.exitCode = 255; this.emit('close', 255, null); }); }
  kill(): boolean { return true; }
}

describe('reaching a machine that is off', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function open(extra: { networkSignature?: () => string } = {}): { link: RemoteLink; attempts: number[] } {
    const attempts: number[] = [];
    const link = new RemoteLink(newMachineRecord({ name: 'macbook', sshTarget: 'macbook', ready: true }), () => undefined, {
      spawn: () => { attempts.push(Date.now()); return new DeadHost() as unknown as ChildProcess; },
      autoUpdate: false, localCommit: undefined, ...extra,
    });
    link.start();
    return { link, attempts };
  }

  it('backs off from seconds to ten minutes and stays there: an hour is a handful of tries, not a hundred', async () => {
    const { link, attempts } = open({ networkSignature: () => 'same' });
    try {
      await vi.advanceTimersByTimeAsync(3_600_000);
      const gaps = attempts.slice(1).map((at, index) => at - attempts[index]!);
      expect(gaps.every((gap, index) => index === 0 || gap >= gaps[index - 1]!)).toBe(true);
      expect(Math.max(...gaps)).toBe(600_000);
      expect(attempts.length).toBeLessThan(20);
    } finally { await link.stop(); }
  });

  it('a user action tries it at once, whatever the pause', async () => {
    const { link, attempts } = open({ networkSignature: () => 'same' });
    try {
      await vi.advanceTimersByTimeAsync(600_000);
      const before = attempts.length;
      link.wake();
      // wake only acts on a link parked for want of a viewer; a link on a timer is cut short by reconnect().
      link.reconnect();
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts.length).toBeGreaterThan(before);
    } finally { await link.stop(); }
  });

  it('a change of the network tries it within the poll, and the pause starts over', async () => {
    let network = 'wifi-a';
    const { link, attempts } = open({ networkSignature: () => network });
    try {
      await vi.advanceTimersByTimeAsync(400_000);
      const before = attempts.length;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(attempts.length).toBe(before);
      network = 'wifi-b';
      await vi.advanceTimersByTimeAsync(30_000);
      expect(attempts.length).toBeGreaterThan(before);
      // The pause starts over from its short end: the next try after the one the change made is a second later.
      expect(attempts[before + 1]! - attempts[before]!).toBe(1_000);
    } finally { await link.stop(); }
  });
});
