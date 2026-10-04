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

describe('a message the transport holds for the next safe moment', () => {
  const held = () => {
    let land!: () => void;
    let fail!: (error: Error) => void;
    const landing = new Promise<void>((resolve, reject) => { land = resolve; fail = reject; });
    return { landing, land: () => land(), fail: (error: Error) => fail(error) };
  };

  it('is queued at once as the fallback, and the queued copy is dropped when it is steered in after all', async () => {
    const broker = new LiveTurnInputBroker({ steerTimeoutMs: 50 });
    const queued: Array<[string, boolean | undefined]> = [];
    const unqueued: string[] = [];
    broker.bindQueue(async (submission, options) => { queued.push([submission.id, options?.held]); });
    broker.setLateSteerHandler((submission) => unqueued.push(submission.id));
    const step = held();
    let queuedBeforeSend = false;
    broker.setSteerHandler(async (_text, _submission, hold) => {
      await hold();
      queuedBeforeSend = queued.length === 1;
      await step.landing;
    });
    const result = await broker.submit('after the tool', 'row-1');
    expect(result.disposition).toBe('queued');
    expect(queued).toEqual([['row-1', true]]);
    // Held well past the steer timeout: a hold is not a slow steer.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(unqueued).toEqual([]);
    step.land();
    await broker.settled();
    expect(queuedBeforeSend).toBe(true);
    expect(unqueued).toEqual(['row-1']);
  });

  it('keeps the queued copy -- the only one -- when the turn ends before it could be steered', async () => {
    const broker = new LiveTurnInputBroker();
    const queued: string[] = [];
    const unqueued: string[] = [];
    broker.bindQueue(async (submission) => { queued.push(submission.id); });
    broker.setLateSteerHandler((submission) => unqueued.push(submission.id));
    const step = held();
    broker.setSteerHandler(async (_text, _submission, hold) => { void hold(); await step.landing; });
    expect((await broker.submit('next turn', 'row-2')).disposition).toBe('queued');
    step.fail(new Error('turn ended'));
    await broker.settled();
    expect(queued).toEqual(['row-2']);
    expect(unqueued).toEqual([]);
  });

  it('goes back to the composer, and tells the transport to drop it, when the fallback cannot be written', async () => {
    const broker = new LiveTurnInputBroker();
    broker.bindQueue(async () => { throw new Error('disk full'); });
    let holdOutcome: unknown;
    broker.setSteerHandler(async (_text, _submission, hold) => {
      await hold().catch((error: unknown) => { holdOutcome = error; throw error; });
    });
    await expect(broker.submit('kept')).rejects.toThrow('disk full');
    await broker.settled();
    expect(String(holdOutcome)).toContain('disk full');
  });
});
