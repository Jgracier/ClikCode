import { afterEach, describe, expect, it, vi } from 'vitest';
import { acknowledgeHeldSteer, heldSteerNote } from './steer-ack.js';

afterEach(() => vi.useRealTimers());

describe('the reply to a held steer', () => {
  it('says received, held, and what it waits behind, at once', () => {
    const said: string[] = [];
    acknowledgeHeldSteer('use postgres please', new Promise(() => undefined), { say: (m) => said.push(m), openCall: () => ({ label: '$ pnpm test', seconds: 400, count: 2 }) });
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/Steer received: "use postgres please"/);
    expect(said[0]).toMatch(/Held until \$ pnpm test \(\+1 more\) \(running 7 min\) pauses/);
    expect(said[0]).toMatch(/Nothing was stopped/);
  });

  it('keeps answering while held, then says it was delivered', async () => {
    vi.useFakeTimers();
    const said: string[] = [];
    let land!: (steered: boolean) => void;
    acknowledgeHeldSteer('hi', new Promise<boolean>((resolve) => { land = resolve; }), { say: (m) => said.push(m), openCall: () => undefined }, 1000);
    await vi.advanceTimersByTimeAsync(2100);
    expect(said.filter((m) => m.startsWith('Still held'))).toHaveLength(2);
    land(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(said.at(-1)).toMatch(/^Delivered to the model/);
    await vi.advanceTimersByTimeAsync(5000);
    expect(said.filter((m) => m.startsWith('Still held'))).toHaveLength(2);
  });

  it('says it runs next when the turn ended first', async () => {
    const said: string[] = [];
    acknowledgeHeldSteer('hi', Promise.resolve(false), { say: (m) => said.push(m), openCall: () => undefined });
    await Promise.resolve(); await Promise.resolve();
    expect(said.at(-1)).toMatch(/runs as your next message/);
    expect(heldSteerNote('x', undefined)).toMatch(/the current call/);
  });
});
