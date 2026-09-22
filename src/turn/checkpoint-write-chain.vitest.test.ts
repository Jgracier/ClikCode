import { describe, expect, it } from 'vitest';

/**
 * One failed write must not stop every write after it.
 *
 * DurableTurnCheckpoint serialises its writes through a promise chain:
 * `this.writes = this.writes.then(() => writeState(...))`. That shape has a
 * trap. `.then()` on a REJECTED promise never runs its callback, so as soon as
 * one write failed, `this.writes` stayed rejected and writeState was never
 * called again -- for the rest of that checkpoint's life. The turn went on
 * streaming, the UI looked perfectly healthy, and nothing was saved. No error
 * surfaced anywhere, because the only caller that could have seen it was a
 * `void ...catch(() => undefined)`.
 *
 * These reproduce the chain in isolation, because the bug is in the SHAPE of
 * the chain rather than in anything about sessions or disks: a test that went
 * through the real class would need a filesystem that fails exactly once, and
 * would prove less clearly why the shape matters.
 */
describe('a serialised write chain survives a failed write', () => {
  /** The original, buggy shape. Kept so the fix below is measured against the
   *  real thing rather than a paraphrase of it. */
  function poisonedChain() {
    let writes: Promise<void> = Promise.resolve();
    let calls = 0;
    const write = (fail: boolean): Promise<void> => {
      calls += 1;
      return fail ? Promise.reject(new Error('disk full')) : Promise.resolve();
    };
    return {
      enqueue: (fail = false): Promise<void> => (writes = writes.then(() => write(fail))),
      get calls() { return calls; },
    };
  }

  /** The shipped shape: the chain the NEXT write builds on is always settled,
   *  while the promise handed to THIS caller keeps its own real failure. */
  function recoveringChain() {
    let writes: Promise<void> = Promise.resolve();
    let calls = 0;
    const write = (fail: boolean): Promise<void> => {
      calls += 1;
      return fail ? Promise.reject(new Error('disk full')) : Promise.resolve();
    };
    return {
      enqueue: (fail = false): Promise<void> => {
        const current = writes.catch(() => undefined).then(() => write(fail));
        writes = current.catch(() => undefined);
        return current;
      },
      get calls() { return calls; },
    };
  }

  it('demonstrates the original bug: writes stop after the first failure', async () => {
    const chain = poisonedChain();
    await chain.enqueue(false).catch(() => undefined);
    await chain.enqueue(true).catch(() => undefined);
    await chain.enqueue(false).catch(() => undefined);
    await chain.enqueue(false).catch(() => undefined);
    // Four asked for, two attempted: everything after the failure was skipped
    // silently. This is the behaviour that shipped.
    expect(chain.calls).toBe(2);
  });

  it('keeps writing after a failure', async () => {
    const chain = recoveringChain();
    await chain.enqueue(false).catch(() => undefined);
    await chain.enqueue(true).catch(() => undefined);
    await chain.enqueue(false).catch(() => undefined);
    await chain.enqueue(false).catch(() => undefined);
    expect(chain.calls).toBe(4);
  });

  it('still reports the failing write to its own caller', async () => {
    const chain = recoveringChain();
    await expect(chain.enqueue(true)).rejects.toThrow('disk full');
    // And the next caller is not handed someone else's failure.
    await expect(chain.enqueue(false)).resolves.toBeUndefined();
  });
});
