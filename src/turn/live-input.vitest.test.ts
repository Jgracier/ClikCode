import { describe, expect, it } from 'vitest';
import { LiveTurnInputBroker, type SteerPort } from './live-input.js';
import { fakeLedger } from './test-support/live-ledger.js';

/** A port that takes a message only while `open`. */
function fakePort(initiallyOpen = true) {
  const state = { open: initiallyOpen, offered: [] as string[] };
  const port: SteerPort = {
    offer: async (text) => { state.offered.push(text); return state.open; },
  };
  return { port, state, openWindow: () => { state.open = true; port.onWindow?.(); } };
}

const bound = (options?: Parameters<typeof fakeLedger>[0]) => {
  const broker = new LiveTurnInputBroker();
  const fake = fakeLedger(options);
  broker.bindLedger(fake.ledger);
  return { broker, ...fake };
};

describe('a message typed while a turn runs', () => {
  it('goes straight into a turn that can take it, and is never queued', async () => {
    const { broker, queue, steered } = bound();
    const { port } = fakePort();
    broker.setSteerPort(port);
    const result = await broker.submit('use postgres', 'm1', { steer: true });
    expect(result.disposition).toBe('steered');
    expect(steered.map((item) => item.id)).toEqual(['m1']);
    expect(queue).toEqual([]);
  });

  it('waits in the queue, marked to go in, until the turn has an opening, then goes in once', async () => {
    const { broker, queue, steered } = bound();
    const fake = fakePort(false);
    let later = 0;
    broker.onLaterDelivery(() => { later += 1; });
    broker.setSteerPort(fake.port);
    const result = await broker.submit('use postgres', 'm1', { steer: true });
    expect(result.disposition).toBe('queued');
    expect(result.unsteered).toBeUndefined();
    expect(queue.map((item) => [item.id, item.steer])).toEqual([['m1', true]]);
    fake.openWindow();
    await broker.settled();
    expect(steered.map((item) => item.id)).toEqual(['m1']);
    expect(queue).toEqual([]);
    expect(later).toBe(1);
  });

  it('goes in oldest first, and a newer one never overtakes one still waiting', async () => {
    const { broker, steered } = bound();
    const fake = fakePort(false);
    broker.setSteerPort(fake.port);
    await broker.submit('first', 'a', { steer: true });
    await broker.submit('second', 'b', { steer: true });
    fake.openWindow();
    await broker.settled();
    expect(steered.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('is left queued for the turn to end when the turn has no way to take it, and the row says so', async () => {
    const { broker, queue } = bound();
    const result = await broker.submit('later please', 'm1', { steer: true });
    expect(result).toMatchObject({ disposition: 'queued', unsteered: true });
    expect(queue.map((item) => item.id)).toEqual(['m1']);
  });

  it('in queue mode waits for the turn to end, whatever the turn could take', async () => {
    const { broker, queue } = bound();
    const fake = fakePort();
    broker.setSteerPort(fake.port);
    const result = await broker.submit('after this', 'm1', { steer: false });
    expect(result).toMatchObject({ disposition: 'queued' });
    expect(result.unsteered).toBeUndefined();
    expect(fake.state.offered).toEqual([]);
    expect(queue.map((item) => [item.id, item.steer])).toEqual([['m1', undefined]]);
  });

  it('is queued, not lost, when the turn refuses it or has ended', async () => {
    const { broker, queue } = bound();
    const port: SteerPort = { offer: async () => { throw new Error('turn ended'); } };
    broker.setSteerPort(port);
    const result = await broker.submit('still wanted', 'm1', { steer: true });
    expect(result.disposition).toBe('queued');
    expect(queue.map((item) => item.id)).toEqual(['m1']);
  });

  it('goes back to the composer when it could not be written', async () => {
    const { broker } = bound({ failQueue: true });
    await expect(broker.submit('x', 'm1', { steer: true })).rejects.toThrow('disk full');
  });

  it('is released with an error when the turn ends before its queue was ready', async () => {
    const broker = new LiveTurnInputBroker();
    const pending = broker.submit('early', 'm1', { steer: true });
    broker.close();
    await expect(pending).rejects.toThrow('turn ended before live input was ready');
  });

  it('rejects an empty message', async () => {
    const { broker } = bound();
    await expect(broker.submit('   ', 'm1', { steer: true })).rejects.toThrow('empty');
  });

  it('keeps the id it was typed under, so its saved copy matches its row', async () => {
    const { broker, steered } = bound();
    broker.setSteerPort(fakePort().port);
    const result = await broker.submit('yes', 'row-7', { steer: true });
    expect(result.submission.id).toBe('row-7');
    expect(steered[0]!.id).toBe('row-7');
  });
});

describe('Enter again', () => {
  it('offers the oldest queued message to the turn now, and never forces it in', async () => {
    const { broker, queue, steered } = bound();
    const fake = fakePort(false);
    broker.setSteerPort(fake.port);
    await broker.submit('queued one', 'a', { steer: false });
    await broker.submit('queued two', 'b', { steer: false });
    expect(await broker.sendNow()).toMatchObject({ submission: { id: 'a' }, steered: false });
    expect(queue.map((item) => [item.id, item.steer])).toEqual([['a', true], ['b', undefined]]);
    fake.openWindow();
    await broker.settled();
    expect(steered.map((item) => item.id)).toEqual(['a']);
    expect(queue.map((item) => item.id)).toEqual(['b']);
  });

  it('puts it in at once when the turn can take it', async () => {
    const { broker, steered } = bound();
    const fake = fakePort(false);
    broker.setSteerPort(fake.port);
    await broker.submit('queued', 'a', { steer: false });
    fake.state.open = true;
    expect(await broker.sendNow()).toMatchObject({ submission: { id: 'a' }, steered: true });
    expect(steered.map((item) => item.id)).toEqual(['a']);
  });

  it('keeps the order when the turn cannot steer at all: nothing is taken out and put back', async () => {
    const { broker, queue } = bound();
    await broker.submit('one', 'a', { steer: false });
    await broker.submit('two', 'b', { steer: false });
    expect(await broker.sendNow()).toMatchObject({ steered: false });
    expect(queue.map((item) => item.id)).toEqual(['a', 'b']);
    expect(broker.steerable).toBe(false);
  });

  it('does nothing when nothing waits', async () => {
    const { broker } = bound();
    expect(await broker.sendNow()).toBeUndefined();
  });
});

describe('taking a waiting message back', () => {
  it('removes it from the queue', async () => {
    const { broker, queue } = bound();
    await broker.submit('oops', 'a', { steer: false });
    expect(await broker.takeBack('a')).toBe('removed');
    expect(queue).toEqual([]);
    expect(await broker.takeBack('a')).toBe('gone');
  });

  it('is too late once it is being put into the turn, so it is never both taken back and sent', async () => {
    const { broker, steered } = bound();
    let release!: () => void;
    const port: SteerPort = { offer: () => new Promise<boolean>((resolve) => { release = () => resolve(true); }) };
    broker.setSteerPort(port);
    const submitted = broker.submit('mid-air', 'a', { steer: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await broker.takeBack('a')).toBe('running');
    release();
    expect((await submitted).disposition).toBe('steered');
    expect(steered.map((item) => item.id)).toEqual(['a']);
  });
});

describe('a note from ClikCode', () => {
  it('is offered to the turn like a message and never queued', async () => {
    const { broker, queue } = bound();
    const fake = fakePort();
    broker.setSteerPort(fake.port);
    expect(await broker.steerNote('resource note')).toBe(true);
    expect(fake.state.offered).toEqual(['resource note']);
    expect(queue).toEqual([]);
  });

  it('is kept by the caller when it is not a moment, or nothing could take it', async () => {
    const { broker } = bound();
    expect(await broker.steerNote('nobody home')).toBe(false);
    broker.setSteerPort(fakePort(false).port);
    expect(await broker.steerNote('not now')).toBe(false);
  });
});

describe('a turn that ends with an offer unanswered', () => {
  it('does not hold the broker: the message stays queued for the next turn', async () => {
    const { broker, queue } = bound();
    const port: SteerPort = { offer: () => new Promise<boolean>(() => undefined) };
    broker.setSteerPort(port);
    const submitted = broker.submit('never answered', 'a', { steer: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    broker.setSteerPort(undefined);
    expect((await submitted).disposition).toBe('queued');
    expect(queue.map((item) => item.id)).toEqual(['a']);
  });

  it('keeps a message queued when its turn record cannot take it', async () => {
    const { broker, queue } = bound({ failDelivered: true });
    broker.setSteerPort(fakePort().port);
    const result = await broker.submit('finishing', 'a', { steer: true });
    expect(result.disposition).toBe('queued');
    expect(queue.map((item) => item.id)).toEqual(['a']);
  });
});
