/** A newer build replaces a worker only once nothing has happened in it for RETIRE_QUIET_MS:
 * the vendor working out of turn comes in bursts, and a window reload is a disconnect of a
 * second; retiring in either gap cut a running turn off (2026-10-21). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./registry.js', () => ({ currentWorkerBuild: () => 'new-build' }));
vi.mock('../turn/vendor-process.js', () => ({
  closePersistentTransport: async () => undefined, hasPersistentTransport: () => false, persistentWorkRunning: async () => false,
}));
// The real quiet period (vitest.setup.ts makes it 0 for every other test).
process.env.CLIKCODE_WORKER_RETIRE_QUIET_MS = '30000';
const { createIdleControl, RETIRE_QUIET_MS } = await import('./worker-idle.js');

const worker = () => {
  const shutdown = vi.fn(async () => undefined);
  const observer = { attachedCount: 0, lastActivityAt: Date.now() };
  const ctx = {
    observer, sessionId: 's1', agentSession: { notifications: [], wakeups: new Map(), shells: new Map() },
    turnRunning: false, draining: false, vendorBackground: { busy: false }, outOfTurn: { active: false }, submitsInFlight: 0,
    resumeWaiter: { pending: false }, spawnedBuild: 'old-build', retireWhenIdle: false, shutdown,
  } as never;
  return { ctx: ctx as { submitsInFlight: number; observer: typeof observer; vendorBackground: { busy: boolean }; outOfTurn: { active: boolean } }, idle: createIdleControl(ctx), shutdown };
};

describe('replacing a worker for a newer build', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('waits until it has been quiet, then goes silently', async () => {
    const { idle, shutdown } = worker();
    idle.leaveIfStaleBuild();
    await vi.advanceTimersByTimeAsync(RETIRE_QUIET_MS - 1_000);
    expect(shutdown).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(shutdown).toHaveBeenCalledWith('replaced by a newer ClikCode build');
  });

  it('never goes while the vendor works out of turn, or between its bursts', async () => {
    const { ctx, idle, shutdown } = worker();
    ctx.outOfTurn.active = true;
    idle.leaveIfStaleBuild();
    await vi.advanceTimersByTimeAsync(RETIRE_QUIET_MS * 2);
    expect(shutdown).not.toHaveBeenCalled();
    // A gap between bursts: still recent activity, so not yet.
    ctx.outOfTurn.active = false;
    ctx.observer.lastActivityAt = Date.now();
    idle.leaveIfStaleBuild();
    await vi.advanceTimersByTimeAsync(RETIRE_QUIET_MS / 2);
    expect(shutdown).not.toHaveBeenCalled();
    ctx.vendorBackground.busy = true;
    await vi.advanceTimersByTimeAsync(RETIRE_QUIET_MS);
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('does not go the moment a window drops: a reload reconnects within the quiet time', async () => {
    const { ctx, idle, shutdown } = worker();
    await vi.advanceTimersByTimeAsync(RETIRE_QUIET_MS * 2);
    // The window detaching is activity.
    ctx.observer.lastActivityAt = Date.now();
    idle.leaveIfStaleBuild();
    await vi.advanceTimersByTimeAsync(1_000);
    ctx.observer.attachedCount = 1;
    await vi.advanceTimersByTimeAsync(RETIRE_QUIET_MS * 2);
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('never goes while a submit it accepted has not been answered: that message is about to be a turn', async () => {
    const { ctx, idle, shutdown } = worker();
    ctx.submitsInFlight = 1;
    idle.leaveIfStaleBuild();
    await vi.advanceTimersByTimeAsync(RETIRE_QUIET_MS * 2);
    expect(shutdown).not.toHaveBeenCalled();
    expect(idle.retireBlocker()).toBe('a turn is running');
  });
});
