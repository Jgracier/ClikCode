/** `/send` is one global setting for every harness. Whatever transport runs
 * the turn publishes at most one steer handler to the turn's broker, and the
 * broker is the only place that decides steer or queue, so each transport
 * kind is stood in for here by the handler (or absence of one) it publishes. */
import { describe, expect, it, vi } from 'vitest';
import { LiveTurnInputBroker } from './live-input.js';
import { deliverTyped } from './send-mode.js';

type Handler = Parameters<LiveTurnInputBroker['setSteerHandler']>[0];

const TRANSPORTS: Array<{ kind: string; handler: () => Handler | undefined }> = [
  { kind: 'ClikCode agent (steerQueue)', handler: () => vi.fn(async () => undefined) },
  { kind: 'native stream-json CLI (stdin)', handler: () => vi.fn(async () => undefined) },
  { kind: 'ACP with steering, safe moment', handler: () => vi.fn(async () => undefined) },
  { kind: 'ACP with steering, held for a pause', handler: () => vi.fn(async (_t, _s, hold) => { await hold(() => true); }) },
  { kind: 'codex-app-server (turn/steer)', handler: () => vi.fn(async () => undefined) },
];
const UNSTEERABLE = ['ACP without steering', 'structured-cli one-shot', 'text-cli one-shot'];

async function broker(handler: Handler | undefined) {
  const b = new LiveTurnInputBroker();
  const queued = vi.fn(async () => undefined);
  b.bindQueue(queued);
  b.setSteerHandler(handler);
  return { b, queued };
}

describe('/send across transport kinds', () => {
  for (const { kind, handler } of TRANSPORTS) {
    it(`${kind}: steer (and no setting at all) reaches its handler; queue never does`, async () => {
      for (const settings of [undefined, {}, { sendMode: 'steer' }]) {
        const steer = handler();
        const { b } = await broker(steer);
        await deliverTyped(b, 'go left', 'a', settings);
        expect(steer).toHaveBeenCalledOnce();
      }
      const steer = handler();
      const { b, queued } = await broker(steer);
      const result = await deliverTyped(b, 'go right', 'b', { sendMode: 'queue' });
      expect(steer).not.toHaveBeenCalled();
      expect(result).toMatchObject({ disposition: 'queued' });
      expect(result.unsteered).toBeUndefined();
      expect(queued).toHaveBeenCalledOnce();
    });
  }

  for (const kind of UNSTEERABLE) {
    it(`${kind}: queues in both modes, and only steer mode says it could not steer`, async () => {
      const { b, queued } = await broker(undefined);
      expect(await deliverTyped(b, 'x', 'a', undefined)).toMatchObject({ disposition: 'queued', unsteered: true });
      const asked = await deliverTyped(b, 'y', 'b', { sendMode: 'queue' });
      expect(asked.disposition).toBe('queued');
      expect(asked.unsteered).toBeUndefined();
      expect(queued).toHaveBeenCalledTimes(2);
    });
  }

  it('a change mid-turn applies to the next message typed', async () => {
    const steer = vi.fn(async () => undefined);
    const { b, queued } = await broker(steer);
    expect((await deliverTyped(b, 'one', '1', undefined)).disposition).toBe('steered');
    expect((await deliverTyped(b, 'two', '2', { sendMode: 'queue' })).disposition).toBe('queued');
    expect((await deliverTyped(b, 'three', '3', { sendMode: 'steer' })).disposition).toBe('steered');
    expect(steer).toHaveBeenCalledTimes(2);
    expect(queued).toHaveBeenCalledTimes(1);
  });

  it('a steer the vendor refuses is queued, never lost', async () => {
    const { b, queued } = await broker(vi.fn(async () => { throw new Error('turn ended'); }));
    expect((await deliverTyped(b, 'late', 'a', undefined)).disposition).toBe('queued');
    expect(queued).toHaveBeenCalledOnce();
  });
});
