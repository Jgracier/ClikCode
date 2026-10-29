/** A prompt that reaches a worker being replaced for a newer build is not lost: the worker refuses it (`submit-rejected`, `retry`), the editor
 * keeps showing it, and the same prompt goes to the worker that replaces the old one. */
import { describe, expect, it, vi } from 'vitest';
import type Conf from 'conf';
import { IdeBridge } from './bridge.js';
import { BridgeTurns } from './bridge-turns.js';
import { WorkerRetiring } from './bridge-support.js';
import type { WorkerEvent } from '../worker/protocol.js';

vi.mock('../session/attach.js', async (original) => ({ ...(await original<object>()), prepareTurn: vi.fn(async () => undefined) }));

interface Link {
  turnWaiter: { resolve: () => void; reject: (error: Error) => void } | undefined;
  onWorkerEvent(sessionId: string, client: unknown, event: WorkerEvent): void;
}

describe('the editor and a worker that refuses a prompt because it is being replaced', () => {
  it('fails the waiting turn with a retry signal and does not show the editor a rejection', () => {
    const sent: unknown[] = [];
    const bridge = new IdeBridge({} as Conf, { send: (message: unknown) => { sent.push(message); } });
    const link = (bridge as unknown as { link: Link }).link;
    const reject = vi.fn();
    link.turnWaiter = { resolve: () => undefined, reject };
    link.onWorkerEvent('s1', {}, { type: 'submit-rejected', message: 'being replaced', retry: true });
    expect(reject).toHaveBeenCalledTimes(1);
    expect(reject.mock.calls[0]![0]).toBeInstanceOf(WorkerRetiring);
    expect(sent, 'a rejection would clear the prompt the editor shows').toEqual([]);
    expect(link.turnWaiter).toBeUndefined();
  });

  it('sends again when the worker left before it said it had the message, but not once it did', () => {
    const bridge = new IdeBridge({} as Conf, { send: () => undefined });
    const link = (bridge as unknown as { link: Link }).link;
    const untaken = vi.fn();
    link.turnWaiter = { resolve: () => undefined, reject: untaken };
    link.onWorkerEvent('s1', {}, { type: 'shutdown', reason: 'replaced by a newer ClikCode build' });
    expect(untaken.mock.calls[0]![0], 'it may never have been read').toBeInstanceOf(WorkerRetiring);

    const taken = vi.fn();
    link.turnWaiter = { resolve: () => undefined, reject: taken };
    link.onWorkerEvent('s1', {}, { type: 'turn-error', message: 'x' });
    link.onWorkerEvent('s1', {}, { type: 'shutdown', reason: 'replaced by a newer ClikCode build' });
    expect(taken.mock.calls[0]![0], 'it has the message: sending again could run it twice').not.toBeInstanceOf(WorkerRetiring);
  });

  it('still tells the editor about an ordinary rejection', () => {
    const sent: unknown[] = [];
    const bridge = new IdeBridge({} as Conf, { send: (message: unknown) => { sent.push(message); } });
    const link = (bridge as unknown as { link: Link }).link;
    link.onWorkerEvent('s1', {}, { type: 'submit-rejected', message: 'no account' });
    expect(sent).toHaveLength(1);
  });
});

/** A host with two workers: the first refuses (it is being replaced), the second takes the prompt. */
function turnsWith(workers: Array<(link: { turnWaiter: { resolve: () => void; reject: (error: Error) => void } | undefined }) => { send: ReturnType<typeof vi.fn> }>) {
  const link = {
    turnWaiter: undefined as { resolve: () => void; reject: (error: Error) => void } | undefined,
    detach: vi.fn(),
    attaches: 0,
    workerFor: vi.fn(async () => workers[Math.min(link.attaches++, workers.length - 1)]!(link)),
  };
  const sent: unknown[] = [];
  const host = { link, channel: { send: (message: unknown) => { sent.push(message); } }, prepareRoute: async () => undefined } as never;
  return { turns: new BridgeTurns(host), link, sent };
}

describe('sending the prompt again to the replacement', () => {
  const retiring = (link: { turnWaiter: { reject: (error: Error) => void } | undefined }) => ({ send: vi.fn(() => { queueMicrotask(() => link.turnWaiter?.reject(new WorkerRetiring('being replaced'))); }) });
  const accepting = (link: { turnWaiter: { resolve: () => void } | undefined }) => ({ send: vi.fn(() => { queueMicrotask(() => link.turnWaiter?.resolve()); }) });

  it('lets go of the old worker, attaches to the next, and sends the same prompt there', async () => {
    const first = vi.fn(retiring), second = vi.fn(accepting);
    const { turns, link, sent } = turnsWith([first as never, second as never]);
    await turns.runTurn('s1', 'hello', { echo: true });
    expect(link.detach).toHaveBeenCalledTimes(1);
    expect(link.workerFor).toHaveBeenCalledTimes(2);
    const oldWorker = first.mock.results[0]!.value as { send: ReturnType<typeof vi.fn> };
    const newWorker = second.mock.results[0]!.value as { send: ReturnType<typeof vi.fn> };
    expect(oldWorker.send).toHaveBeenCalledTimes(1);
    expect(newWorker.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'submit', text: 'hello' }));
    // The editor was told the turn started once, not once per attempt.
    expect(sent.filter((message) => (message as { type?: string }).type === 'turn-start')).toHaveLength(1);
  }, 10_000);

  it('gives up after a few attempts and reports it, rather than waiting for ever', async () => {
    const stubborn = vi.fn(retiring);
    const { turns, link } = turnsWith([stubborn as never]);
    await expect(turns.runTurn('s1', 'hello', { echo: true })).rejects.toBeInstanceOf(WorkerRetiring);
    expect(link.workerFor).toHaveBeenCalledTimes(6);
  }, 20_000);
});
