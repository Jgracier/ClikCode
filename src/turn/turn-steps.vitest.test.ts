import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessSession, HarnessState } from '../session/model.js';

const held = vi.hoisted(() => ({
  has: vi.fn(), wait: vi.fn(async () => undefined), release: vi.fn(async () => undefined),
}));
vi.mock('../harness/transport/native/held-vendor.js', () => ({
  hasHeldVendorProcess: held.has, waitForHeldVendorSubagents: held.wait, releaseHeldVendorProcess: held.release,
}));

import { setPlanMode, settleHeldVendor, unfinishedUsageRecorder } from './turn-steps.js';

describe('unfinishedUsageRecorder', () => {
  const base = { sessionId: 's', accountId: 'a', provider: 'p', model: 'm', startedAt: Date.now() };
  const newState = (): HarnessState => ({ invocations: [] } as unknown as HarnessState);

  it('records what the attempt spent, with why it ended, and touches the checkpoint', () => {
    const state = newState();
    const touch = vi.fn();
    unfinishedUsageRecorder(state, { touch }, () => ({ ...base, usage: { input: 3, output: 5 } }))('error');
    expect(state.invocations).toHaveLength(1);
    expect(state.invocations[0]).toMatchObject({ stopReason: 'error', outputTokens: 5 });
    expect(touch).toHaveBeenCalledOnce();
  });

  it('records nothing for an attempt that spent nothing or has nothing to take', () => {
    const state = newState();
    const touch = vi.fn();
    unfinishedUsageRecorder(state, { touch }, () => ({ ...base, usage: { input: 0, output: 0 } }))('stopped');
    unfinishedUsageRecorder(state, { touch }, () => undefined)('stopped');
    expect(state.invocations).toEqual([]);
    expect(touch).not.toHaveBeenCalled();
  });
});

describe('setPlanMode', () => {
  const session = (): HarnessSession => ({ id: 's', planMode: true } as HarnessSession);
  it('leaving clears the mode, runs the extra clear, saves the turn and redraws', () => {
    const s = session();
    const checkpoint = { touch: vi.fn() };
    const prompter = { render: vi.fn() };
    const extra = vi.fn();
    setPlanMode(s, checkpoint, prompter as never, false, extra);
    expect(s.planMode).toBeUndefined();
    expect(extra).toHaveBeenCalledOnce();
    expect(checkpoint.touch).toHaveBeenCalledOnce();
    expect(prompter.render).toHaveBeenCalledWith(s);
  });
  it('entering sets it, without the exit-only clear', () => {
    const s = { id: 's' } as HarnessSession;
    const extra = vi.fn();
    setPlanMode(s, undefined, undefined, true, extra);
    expect(s.planMode).toBe(true);
    expect(extra).not.toHaveBeenCalled();
  });
});

describe('settleHeldVendor', () => {
  beforeEach(() => { held.has.mockReset(); held.wait.mockClear(); held.release.mockClear(); });
  it('does nothing when no vendor is held', async () => {
    held.has.mockReturnValue(false);
    const prompter = { phase: vi.fn() };
    await settleHeldVendor('s', prompter as never);
    expect(prompter.phase).not.toHaveBeenCalled();
    expect(held.release).not.toHaveBeenCalled();
  });
  it('waits for its subagents, then releases it, saying so', async () => {
    held.has.mockReturnValue(true);
    const order: string[] = [];
    held.wait.mockImplementation(async () => { order.push('wait'); });
    held.release.mockImplementation(async () => { order.push('release'); });
    const prompter = { phase: vi.fn() };
    await settleHeldVendor('s', prompter as never);
    expect(prompter.phase).toHaveBeenCalledWith('waiting for running work');
    expect(order).toEqual(['wait', 'release']);
  });
});
