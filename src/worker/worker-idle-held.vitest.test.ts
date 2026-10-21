import { beforeEach, describe, expect, it, vi } from 'vitest';

const heldVendor = vi.hoisted(() => ({ held: false }));
vi.mock('../harness/transport/native/held-vendor.js', () => ({
  hasHeldVendorProcess: () => heldVendor.held,
  whenHeldVendorGone: () => new Promise<void>(() => undefined),
}));
vi.mock('../runtime/lifecycle-log.js', () => ({ lifecycle: vi.fn() }));

const { createIdleControl } = await import('./worker-idle.js');

const build = (over: Record<string, unknown> = {}) => {
  const ctx = {
    observer: { attachedCount: 0 }, sessionId: 'held-reason',
    agentSession: { shells: new Map(), notifications: [] as unknown[], wakeups: new Map() },
    turnRunning: false, draining: false, vendorBackground: { busy: false }, outOfTurn: { active: false }, resumeWaiter: { pending: false },
    idleTimer: undefined as NodeJS.Timeout | undefined, homeGone: () => false, shutdown: vi.fn(),
    ...over,
  };
  return { ctx, idle: createIdleControl(ctx as never) };
};

beforeEach(() => { heldVendor.held = false; });

describe('heldReason: the one list of what holds a worker', () => {
  it('is undefined when nothing holds it', () => {
    const { idle } = build();
    expect(idle.heldReason('retire')).toBeUndefined();
    expect(idle.heldReason('idle')).toBeUndefined();
  });

  it.each([
    ['a running turn', { turnRunning: true }, 'a turn is running'],
    ['vendor background work', { vendorBackground: { busy: true } }, 'vendor background work is running'],
    ['a pending notification', { agentSession: { shells: new Map(), notifications: [{}], wakeups: new Map() } }, 'a notification is on its way to the model'],
    ['a scheduled wakeup', { agentSession: { shells: new Map(), notifications: [], wakeups: new Map([['w', {}]]) } }, 'a scheduled wakeup is pending'],
    ['a running background shell', { agentSession: { shells: new Map([['s', { status: 'running', startedAt: 1 }]]), notifications: [], wakeups: new Map() } }, 'a background shell is running'],
  ])('holds for %s in both scopes', (_name, over, reason) => {
    const { idle } = build(over);
    expect(idle.heldReason('retire')).toBe(reason);
    expect(idle.heldReason('idle')).toBe(reason);
  });

  it('holds for a vendor finishing its background work in both scopes', () => {
    heldVendor.held = true;
    const { idle } = build();
    expect(idle.heldReason('retire')).toBe('a vendor is still finishing its background work');
    expect(idle.heldReason('idle')).toBe('a vendor is still finishing its background work');
  });

  it('where the callers disagree: attached windows and a quota-reset wait hold the idle exit, not a retirement', () => {
    const windows = build({ observer: { attachedCount: 2 } });
    expect(windows.idle.heldReason('idle')).toBe('2 window(s) attached');
    expect(windows.idle.heldReason('retire')).toBeUndefined();
    const quota = build({ resumeWaiter: { pending: true } });
    expect(quota.idle.heldReason('idle')).toBe('waiting for a quota reset');
    expect(quota.idle.heldReason('retire')).toBeUndefined();
  });

  it('where the callers disagree: a queue being drained holds a retirement, not the idle exit', () => {
    const { idle } = build({ draining: true });
    expect(idle.heldReason('retire')).toBe('a turn is running');
    expect(idle.heldReason('idle')).toBeUndefined();
  });

  it('the idle exit logs the held reason and arms no exit timer while held', () => {
    const { ctx, idle } = build({ turnRunning: true });
    idle.scheduleIdleExit();
    expect(ctx.idleTimer).toBeUndefined();
  });

  it('arms the exit timer when nothing holds it', () => {
    const { ctx, idle } = build();
    idle.scheduleIdleExit();
    expect(ctx.idleTimer).toBeDefined();
    clearTimeout(ctx.idleTimer);
  });
});
