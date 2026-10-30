import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessSession, HarnessState } from '../session/model.js';

const held = vi.hoisted(() => ({
  has: vi.fn(), wait: vi.fn(async (..._args: unknown[]) => undefined), release: vi.fn(async () => undefined),
  reported: vi.fn(), retire: vi.fn(), owner: vi.fn(), changed: vi.fn(),
}));
vi.mock('../harness/transport/native/held-vendor.js', () => ({
  hasHeldVendorProcess: held.has, waitForHeldVendorSubagents: held.wait, releaseHeldVendorProcess: held.release,
  retireHeldVendorProcess: held.retire, heldVendorOwner: held.owner,
}));
vi.mock('./vendor-process.js', () => ({ reportEndedWork: held.reported, retiredWorkChanged: held.changed }));

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
  beforeEach(() => {
    held.has.mockReset(); held.wait.mockClear(); held.release.mockClear(); held.reported.mockClear();
    held.retire.mockReset(); held.owner.mockReset(); held.changed.mockClear();
  });
  it('does nothing when no vendor is held', async () => {
    held.has.mockReturnValue(false);
    const prompter = { phase: vi.fn() };
    await settleHeldVendor('s', prompter as never);
    expect(prompter.phase).not.toHaveBeenCalled();
    expect(held.release).not.toHaveBeenCalled();
  });
  it('on the same account waits for its subagents with no clock, then releases it', async () => {
    held.has.mockReturnValue(true);
    held.owner.mockReturnValue({ harness: 'claude', accountId: 'a' });
    const order: string[] = [];
    held.wait.mockImplementation(async () => { order.push('wait'); });
    held.release.mockImplementation(async () => { order.push('release'); });
    const prompter = { phase: vi.fn() };
    await settleHeldVendor('s', prompter as never, undefined, { to: { harness: 'claude', accountId: 'a' } });
    expect(prompter.phase).toHaveBeenCalledWith('waiting for running work');
    expect(held.wait).toHaveBeenCalledWith('s', undefined);
    expect(order).toEqual(['wait', 'release']);
    expect(held.retire).not.toHaveBeenCalled();
  });
  it('a switch to another account retires the process: its agents are not waited on or killed, their end is told', async () => {
    held.has.mockReturnValue(true);
    held.owner.mockReturnValue({ harness: 'claude', accountId: 'a' });
    held.retire.mockImplementation((_id: string, onEnded: (ended: unknown[]) => void) => { retired = onEnded; return true; });
    let retired: ((ended: unknown[]) => void) | undefined;
    await settleHeldVendor('s', undefined, undefined, { to: { harness: 'claude', accountId: 'b' } });
    expect(held.wait).not.toHaveBeenCalled();
    expect(held.release).not.toHaveBeenCalled();
    retired!([{ kind: 'agent', outcome: 'finished' }]);
    expect(held.reported).toHaveBeenCalledWith('s', [{ kind: 'agent', outcome: 'finished' }], { harness: 'claude', accountId: 'a', retired: true });
  });
  it('a failed attempt retires too; with no agent running it is only released, never waited on', async () => {
    held.has.mockReturnValue(true);
    held.retire.mockReturnValue(false);
    const prompter = { phase: vi.fn() };
    await settleHeldVendor('s', prompter as never, undefined, { failed: true });
    expect(held.retire).toHaveBeenCalled();
    expect(held.wait).not.toHaveBeenCalled();
    expect(prompter.phase).not.toHaveBeenCalled();
    expect(held.release).toHaveBeenCalled();
  });
});
