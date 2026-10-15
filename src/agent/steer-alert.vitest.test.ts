import { describe, expect, it } from 'vitest';
import { BackgroundAgents } from './background-agents.js';
import { holdSteer, releaseHeldSteers, steerAlert, type TurnRuntime } from './turn-runtime.js';

const fakeRuntime = (): TurnRuntime => ({ steerQueue: [], steerWaiters: new Set(), steerOpen: true, callsOpen: 1, heldSteers: [], foregroundSteers: new Map() }) as unknown as TurnRuntime;

describe('a steer held behind a running call', () => {
  it('fires the call alert at once, then reaches the model when the call returns', async () => {
    const rt = fakeRuntime();
    const alert = steerAlert(rt);
    expect(alert.signal.aborted).toBe(false);
    const landed = holdSteer(rt, 'use postgres', () => Promise.resolve());
    expect(alert.signal.aborted).toBe(true);
    rt.callsOpen = 0;
    await releaseHeldSteers(rt);
    await landed;
    expect(rt.steerQueue).toEqual(['use postgres']);
  });

  it('a call that starts while one is already held is alerted immediately', () => {
    const rt = fakeRuntime();
    void holdSteer(rt, 'x', () => Promise.resolve());
    expect(steerAlert(rt).signal.aborted).toBe(true);
  });

  it('agent_wait returns early on a steer and leaves the agent running', async () => {
    const agents = new BackgroundAgents();
    agents.start('long', () => new Promise(() => undefined));
    const steer = new AbortController();
    setTimeout(() => steer.abort(), 50);
    const begun = Date.now();
    const result = await agents.wait('agent_1', 600, undefined, steer.signal);
    expect(Date.now() - begun).toBeLessThan(3_000);
    expect(result.output).toMatch(/user sent a message.*agent_1 still running: nothing was stopped/s);
    expect(agents.running()).toBe(1);
  });
});
