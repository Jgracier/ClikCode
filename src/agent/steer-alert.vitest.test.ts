import { describe, expect, it } from 'vitest';
import { BackgroundAgents } from './background-agents.js';
import { steerAlert, type TurnRuntime } from './turn-runtime.js';

const fakeRuntime = (): TurnRuntime => ({ steerQueue: [], steerWaiters: new Set(), steerOpen: true, callsOpen: 1, foregroundSteers: new Map() }) as unknown as TurnRuntime;

describe('a steer typed while a call runs', () => {
  it('fires the call alert at once, so a call that can wait returns and the model hears it', () => {
    const rt = fakeRuntime();
    const alert = steerAlert(rt);
    expect(alert.signal.aborted).toBe(false);
    rt.steerQueue.push('use postgres');
    for (const wake of [...rt.steerWaiters]) wake();
    expect(alert.signal.aborted).toBe(true);
  });

  it('a call that starts while a steer is still unheard is alerted immediately', () => {
    const rt = fakeRuntime();
    rt.steerQueue.push('x');
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
