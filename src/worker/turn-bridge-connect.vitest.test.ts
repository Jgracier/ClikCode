/** One worker connection per conversation in a window, however many callers
 * race to make it -- also when a look for a running worker finds none and
 * several callers that may start one were waiting on that look. */
import { describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  let none!: (value: undefined) => void;
  const client = () => ({ on: () => undefined, off: () => undefined, send: () => undefined, close: () => undefined, initialEvent: undefined });
  return {
    attach: vi.fn(async () => client()),
    attachExisting: vi.fn(() => new Promise<undefined>((resolve) => { none = resolve; })),
    findNone: () => none(undefined),
  };
});
vi.mock('./client.js', () => ({ WorkerClient: { attach: fake.attach, attachExisting: fake.attachExisting } }));

import { prepareSessionWorker, workerTurn } from './turn-bridge.js';

describe('a window connecting to its conversation\'s worker', () => {
  it('starts one worker when the look for a running one found none and several callers waited on it', async () => {
    const looking = workerTurn('s1');
    const first = prepareSessionWorker('s1', { spawn: true });
    const second = prepareSessionWorker('s1', { spawn: true });
    fake.findNone();
    await Promise.all([looking, first, second]);
    expect(fake.attach).toHaveBeenCalledTimes(1);
  });
});
