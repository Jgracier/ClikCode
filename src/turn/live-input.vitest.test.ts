import { describe, expect, it, vi } from 'vitest';
import { LiveTurnInputBroker } from './live-input.js';

describe('live turn input broker', () => {
  it('queues input durably when the provider has no active steering protocol', async () => {
    const broker = new LiveTurnInputBroker();
    const queued = vi.fn(async () => undefined);
    broker.bindQueue(queued);
    const result = await broker.submit('  follow up  ');
    expect(result.disposition).toBe('queued');
    expect(result.submission.text).toBe('follow up');
    expect(queued).toHaveBeenCalledWith(result.submission);
  });

  it('uses native steering when available and falls back to the queue if the turn has ended', async () => {
    const broker = new LiveTurnInputBroker();
    const queued = vi.fn(async () => undefined);
    broker.bindQueue(queued);
    broker.setSteerHandler(async () => undefined);
    expect((await broker.submit('steer')).disposition).toBe('steered');
    expect(queued).not.toHaveBeenCalled();

    broker.setSteerHandler(async () => { throw new Error('turn already completed'); });
    expect((await broker.submit('too late')).disposition).toBe('queued');
    expect(queued).toHaveBeenCalledOnce();
  });

  it('releases an early submission when turn setup fails before queue binding', async () => {
    const broker = new LiveTurnInputBroker();
    const pending = broker.submit('keep this text');
    broker.close();
    await expect(pending).rejects.toThrow('turn ended before live input was ready');
  });
});

describe('a message keeps the id it was typed under', () => {
  it('is steered and queued under the caller\'s id, so its durable copy matches its row', async () => {
    const steered: string[] = [];
    const queued: string[] = [];
    const broker = new LiveTurnInputBroker();
    broker.bindQueue(async (submission) => { queued.push(submission.id); });
    broker.setSteerHandler(async (_text, submission) => { steered.push(submission.id); });
    expect((await broker.submit('steer this', 'row-1')).submission.id).toBe('row-1');
    broker.setSteerHandler(undefined);
    expect((await broker.submit('queue this', 'row-2')).submission.id).toBe('row-2');
    expect(steered).toEqual(['row-1']);
    expect(queued).toEqual(['row-2']);
  });
});
