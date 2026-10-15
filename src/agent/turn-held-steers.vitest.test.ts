/** A steer typed while a tool call runs is held (the broker queues it as the
 * fallback and the row says "at the next pause") and goes to the model when
 * the last open call returns -- or runs as the next turn if the turn ends. */
import { describe, expect, it } from 'vitest';
import { holdSteer, releaseHeldSteers, type TurnRuntime } from './turn-runtime.js';

const runtime = (callsOpen: number) => ({ steerOpen: true, callsOpen, steerQueue: [] as string[], steerWaiters: new Set<() => void>(), heldSteers: [] } as unknown as TurnRuntime);

describe('a steer typed while a call runs', () => {
  it('reaches the model when the last open call returns, not while one is open', async () => {
    const rt = runtime(2);
    let withdraw: () => boolean = () => false;
    const landed = holdSteer(rt, 'also this', (w) => { withdraw = w; return Promise.resolve(); });
    await releaseHeldSteers(rt);
    expect(rt.steerQueue).toEqual([]);
    rt.callsOpen = 0;
    await releaseHeldSteers(rt);
    await expect(landed).resolves.toBeUndefined();
    expect(rt.steerQueue).toEqual(['also this']);
    expect(withdraw()).toBe(false); // too late to take back: it is in the turn
  });

  it('is never sent once taken back, and rejects so its queued copy stands', async () => {
    const rt = runtime(1);
    let withdraw: () => boolean = () => false;
    const landed = holdSteer(rt, 'never mind', (w) => { withdraw = w; return Promise.resolve(); });
    expect(withdraw()).toBe(true);
    await expect(landed).rejects.toThrow('taken back');
    rt.callsOpen = 0;
    await releaseHeldSteers(rt);
    expect(rt.steerQueue).toEqual([]);
  });

  it('is dropped when its queued fallback could not be written', async () => {
    const rt = runtime(0);
    const landed = holdSteer(rt, 'x', () => Promise.reject(new Error('disk full')));
    await expect(landed).rejects.toThrow('disk full');
    await releaseHeldSteers(rt);
    expect(rt.steerQueue).toEqual([]);
  });
});
