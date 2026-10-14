import { describe, expect, it } from 'vitest';
import { settleStep } from './turn-answer.js';
import type { TurnRuntime } from './turn-runtime.js';

describe('a turn waiting on background agents', () => {
  it('hears a steer typed meanwhile instead of sitting through the wait', async () => {
    const steerQueue: string[] = [];
    const steerWaiters = new Set<() => void>();
    const rt = {
      steerQueue, steerWaiters, signal: undefined, session: { notifications: [] }, input: { onPhase: () => undefined },
      backgroundAgents: { running: () => true, nextFinish: () => new Promise<void>(() => undefined) },
    } as unknown as TurnRuntime;
    const settled = settleStep(rt, { calls: [], cutOff: false, stepText: '', finalOnly: false });
    const outcome = Promise.race([settled, new Promise((resolve) => setTimeout(() => resolve('still waiting'), 300))]);
    steerQueue.push('how much time are you wasting?');
    for (const wake of [...steerWaiters]) wake();
    expect(await outcome).toBe('continue');
    expect(steerWaiters.size).toBe(0);
  });
});
