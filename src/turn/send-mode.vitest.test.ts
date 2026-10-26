import { describe, expect, it, vi } from 'vitest';
import { LiveTurnInputBroker } from './live-input.js';
import { deliverTyped, parseSendMode, sendModeOf } from './send-mode.js';
import { fakeLedger } from './test-support/live-ledger.js';

describe('/send: how a message typed mid-turn is delivered', () => {
  it('is steer unless the user chose queue', () => {
    expect(sendModeOf(undefined)).toBe('steer');
    expect(sendModeOf({})).toBe('steer');
    expect(sendModeOf({ sendMode: 'queue' })).toBe('queue');
    expect(sendModeOf({ sendMode: 'nonsense' })).toBe('steer');
    expect(parseSendMode(' QUEUE ')).toBe('queue');
    expect(() => parseSendMode('later')).toThrow('usage: /send [steer|queue]');
  });

  it('steers into a turn that takes steering, in steer mode', async () => {
    const broker = new LiveTurnInputBroker();
    const { ledger, queue } = fakeLedger();
    const offer = vi.fn(async () => true);
    broker.bindLedger(ledger);
    broker.setSteerPort({ offer });
    expect((await deliverTyped(broker, 'also this', 'a', { sendMode: 'steer' })).disposition).toBe('steered');
    expect(offer).toHaveBeenCalledOnce();
    expect(queue).toEqual([]);
  });

  it('never steers in queue mode, even into a turn that could take it at once', async () => {
    const broker = new LiveTurnInputBroker();
    const { ledger, queue } = fakeLedger();
    const offer = vi.fn(async () => true);
    broker.bindLedger(ledger);
    broker.setSteerPort({ offer });
    const result = await deliverTyped(broker, 'after the turn', 'b', { sendMode: 'queue' });
    expect(result.disposition).toBe('queued');
    expect(offer).not.toHaveBeenCalled();
    expect(queue).toEqual([expect.objectContaining({ id: 'b', text: 'after the turn' })]);
    expect(queue[0]!.steer).toBeUndefined();
  });

  it('queues when steering was asked for and nothing could take it, and the turn says it cannot', async () => {
    const broker = new LiveTurnInputBroker();
    broker.bindLedger(fakeLedger().ledger);
    const result = await deliverTyped(broker, 'into the turn please', 'd', {});
    expect(result.disposition).toBe('queued');
    expect(broker.steerable).toBe(false);
  });
});
