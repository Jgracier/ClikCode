import { describe, expect, it, vi } from 'vitest';
import { LiveTurnInputBroker } from './live-input.js';
import { deliverTyped, parseSendMode, sendModeOf } from './send-mode.js';

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
    const queued = vi.fn(async () => undefined);
    const steer = vi.fn(async () => undefined);
    broker.bindQueue(queued);
    broker.setSteerHandler(steer);
    expect((await deliverTyped(broker, 'also this', 'a', { sendMode: 'steer' })).disposition).toBe('steered');
    expect(steer).toHaveBeenCalledOnce();
    expect(queued).not.toHaveBeenCalled();
  });

  it('never steers in queue mode, even into a turn that could take it at once or hold it', async () => {
    const broker = new LiveTurnInputBroker();
    const queued = vi.fn(async () => undefined);
    const steer = vi.fn(async () => undefined);
    broker.bindQueue(queued);
    broker.setSteerHandler(steer);
    const result = await deliverTyped(broker, 'after the turn', 'b', { sendMode: 'queue' });
    expect(result.disposition).toBe('queued');
    expect(result.unsteered).toBeUndefined();
    expect(steer).not.toHaveBeenCalled();
    expect(queued).toHaveBeenCalledWith(result.submission);
    // An ACP agent that would hold it for the next pause is not asked either.
    const hold = vi.fn(async (_text: string, _submission: unknown, held: (withdraw: () => boolean) => Promise<void>) => { await held(() => true); });
    broker.setSteerHandler(hold);
    expect((await deliverTyped(broker, 'still after', 'c', { sendMode: 'queue' })).disposition).toBe('queued');
    expect(hold).not.toHaveBeenCalled();
  });

  it('says so when steering was asked for and nothing could take it', async () => {
    const broker = new LiveTurnInputBroker();
    broker.bindQueue(async () => undefined);
    const result = await deliverTyped(broker, 'into the turn please', 'd', {});
    expect(result).toMatchObject({ disposition: 'queued', unsteered: true });
  });
});
