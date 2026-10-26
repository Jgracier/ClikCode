/** `/send` is one global setting for every harness. Whatever transport runs
 * the turn publishes at most one steer port to the turn's broker, and the
 * broker is the only place that decides steer or queue, so each transport
 * kind is stood in for here by the port (or absence of one) it publishes. */
import { describe, expect, it, vi } from 'vitest';
import { LiveTurnInputBroker, type SteerPort } from './live-input.js';
import { deliverTyped } from './send-mode.js';
import { fakeLedger } from './test-support/live-ledger.js';

const TRANSPORTS: Array<{ kind: string; port: () => SteerPort & { offer: ReturnType<typeof vi.fn> } }> = [
  { kind: 'ClikCode agent (steerQueue)', port: () => ({ offer: vi.fn(async () => true) }) },
  { kind: 'native stream-json CLI (stdin)', port: () => ({ offer: vi.fn(async () => true) }) },
  { kind: 'ACP with steering, at an opening', port: () => ({ offer: vi.fn(async () => true) }) },
  { kind: 'codex-app-server (turn/steer)', port: () => ({ offer: vi.fn(async () => true) }) },
];
const UNSTEERABLE = ['ACP without steering', 'structured-cli one-shot', 'text-cli one-shot'];

function broker(port: SteerPort | undefined) {
  const b = new LiveTurnInputBroker();
  const fake = fakeLedger();
  b.bindLedger(fake.ledger);
  b.setSteerPort(port);
  return { b, ...fake };
}

describe('/send across transport kinds', () => {
  for (const { kind, port } of TRANSPORTS) {
    it(`${kind}: steer (and no setting at all) reaches its port; queue never does`, async () => {
      for (const settings of [undefined, {}, { sendMode: 'steer' }]) {
        const steer = port();
        const { b } = broker(steer);
        await deliverTyped(b, 'go left', 'a', settings);
        expect(steer.offer).toHaveBeenCalledOnce();
      }
      const steer = port();
      const { b, queue } = broker(steer);
      const result = await deliverTyped(b, 'go right', 'b', { sendMode: 'queue' });
      expect(steer.offer).not.toHaveBeenCalled();
      expect(result).toMatchObject({ disposition: 'queued' });
      expect(queue.map((item) => item.id)).toEqual(['b']);
    });
  }

  for (const kind of UNSTEERABLE) {
    it(`${kind}: queues in both modes`, async () => {
      const { b, queue } = broker(undefined);
      expect((await deliverTyped(b, 'x', 'a', undefined)).disposition).toBe('queued');
      expect((await deliverTyped(b, 'y', 'b', { sendMode: 'queue' })).disposition).toBe('queued');
      expect(b.steerable).toBe(false);
      expect(queue.map((item) => item.id)).toEqual(['a', 'b']);
    });
  }

  it('a change mid-turn applies to the next message typed', async () => {
    const steer: SteerPort = { offer: vi.fn(async () => true) };
    const { b, queue } = broker(steer);
    expect((await deliverTyped(b, 'one', '1', undefined)).disposition).toBe('steered');
    expect((await deliverTyped(b, 'two', '2', { sendMode: 'queue' })).disposition).toBe('queued');
    expect((await deliverTyped(b, 'three', '3', { sendMode: 'steer' })).disposition).toBe('steered');
    expect(steer.offer).toHaveBeenCalledTimes(2);
    expect(queue.map((item) => item.id)).toEqual(['2']);
  });

  it('a steer the vendor refuses is queued, never lost', async () => {
    const { b, queue } = broker({ offer: vi.fn(async () => { throw new Error('turn ended'); }) });
    expect((await deliverTyped(b, 'late', 'a', undefined)).disposition).toBe('queued');
    expect(queue.map((item) => item.id)).toEqual(['a']);
  });
});
