import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelWakeups, disposeSessionState, formatShellNotifications, sessionState, takeShellNotifications } from '../session-state.js';
import { scheduleWakeupTool } from './schedule-wakeup.js';
import type { ToolContext } from '../tool-contract.js';

describe('the schedule_wakeup tool', () => {
  let ctx: ToolContext;
  beforeEach(() => {
    vi.useFakeTimers();
    ctx = { session: sessionState('/tmp/clikcode-wake', `wake-${Math.random()}`) } as ToolContext;
  });
  afterEach(() => {
    cancelWakeups(ctx.session);
    vi.useRealTimers();
  });

  it('queues the prompt for the model when the delay is up, not before', async () => {
    const result = await scheduleWakeupTool.run({ delay_seconds: 120, prompt: 'check the deploy', reason: 'CI takes ~2 min' }, ctx);
    expect(result.output).toMatch(/^Scheduled wake_1 in 120s/);
    expect(ctx.session.wakeups.size).toBe(1);
    vi.advanceTimersByTime(119_000);
    expect(ctx.session.notifications).toHaveLength(0);
    vi.advanceTimersByTime(1_000);
    expect(ctx.session.wakeups.size).toBe(0);
    expect(formatShellNotifications(takeShellNotifications(ctx.session))).toBe('[scheduled wakeup wake_1] CI takes ~2 min\ncheck the deploy');
  });

  it('calls onNotification so an idle worker starts a turn with it', async () => {
    const wake = vi.fn();
    ctx.session.onNotification = wake;
    await scheduleWakeupTool.run({ delay_seconds: 60, prompt: 'p', reason: 'r' }, ctx);
    vi.advanceTimersByTime(60_000);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('clamps the delay to 60..3600 seconds and says so', async () => {
    expect((await scheduleWakeupTool.run({ delay_seconds: 5, prompt: 'p', reason: 'r' }, ctx)).output).toMatch(/in 60s \(clamped from 5s/);
    expect((await scheduleWakeupTool.run({ delay_seconds: 99_999, prompt: 'p', reason: 'r' }, ctx)).output).toMatch(/in 3600s \(clamped from 99999s/);
  });

  it('requires delay, prompt and reason unless stopping', async () => {
    expect((await scheduleWakeupTool.run({ prompt: 'p', reason: 'r' }, ctx)).isError).toBe(true);
    expect((await scheduleWakeupTool.run({ delay_seconds: 60, reason: 'r' }, ctx)).isError).toBe(true);
    expect((await scheduleWakeupTool.run({ delay_seconds: 60, prompt: 'p' }, ctx)).isError).toBe(true);
  });

  it('stop cancels what is pending, and says when nothing was', async () => {
    expect((await scheduleWakeupTool.run({ stop: true }, ctx)).output).toBe('No wakeup was pending.');
    await scheduleWakeupTool.run({ delay_seconds: 60, prompt: 'p', reason: 'r' }, ctx);
    await scheduleWakeupTool.run({ delay_seconds: 90, prompt: 'p', reason: 'r' }, ctx);
    expect((await scheduleWakeupTool.run({ stop: true }, ctx)).output).toBe('Cancelled 2 pending wakeup(s).');
    vi.advanceTimersByTime(3_600_000);
    expect(ctx.session.notifications).toHaveLength(0);
  });

  it('a wakeup the session closes on is reported as lost, never fired late or silently dropped', async () => {
    const stateDir = '/tmp/clikcode-wake-dispose';
    const session = sessionState(stateDir, 'dispose-me');
    await scheduleWakeupTool.run({ delay_seconds: 600, prompt: 'p', reason: 'look at the build' }, { session } as ToolContext);
    const undelivered = disposeSessionState(stateDir, 'dispose-me');
    expect(undelivered).toHaveLength(1);
    expect(formatShellNotifications(undelivered)).toMatch(/^\[background shell wake_1 was stopped: the session closed before it fired/);
    vi.advanceTimersByTime(3_600_000);
    expect(session.notifications).toHaveLength(0);
  });

  it('is gated like bash: an exec tool that acts later', () => {
    expect(scheduleWakeupTool.class).toBe('exec');
  });
});
