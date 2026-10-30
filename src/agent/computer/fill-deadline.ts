/** A fill with no text does page work (reading the fields, the password policy, typing) and sometimes waits for the user's private answer.
 * The page work gets a deadline; the wait for the person does not count against it. When the deadline passes the fill gives up with the
 * label of the field it was on, so one stuck page cannot hold the tool for ten minutes. */
export const FILL_DEADLINE_MS = 30_000;

export class FillTimeout extends Error {
  constructor(readonly field: string) { super(`fill did not finish: ${field}`); }
}

export type FillClock = {
  /** The field being worked on, named in the timeout message. */
  field: string;
  /** Runs a wait that is the person's (a private prompt): the deadline stops counting during it. */
  paused<T>(wait: () => Promise<T>): Promise<T>;
};

/** Runs `work`, rejecting with FillTimeout when more than `ms` of non-paused time passes. The work itself cannot be cancelled; it is left to finish or fail on its own. */
export function withFillDeadline<T>(initialField: string, work: (clock: FillClock) => Promise<T>, ms = FILL_DEADLINE_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let left = ms;
    let startedAt = Date.now();
    let pauses = 0;
    let finished = false;
    const arm = (): void => { startedAt = Date.now(); timer = setTimeout(() => { finished = true; reject(new FillTimeout(clock.field)); }, Math.max(0, left)); };
    const clock: FillClock = {
      field: initialField,
      async paused(wait) {
        if (!finished && pauses++ === 0) { clearTimeout(timer); left -= Date.now() - startedAt; }
        try { return await wait(); }
        finally { if (--pauses === 0 && !finished) arm(); }
      },
    };
    arm();
    work(clock).then(
      value => { if (!finished) { finished = true; clearTimeout(timer); resolve(value); } },
      error => { if (!finished) { finished = true; clearTimeout(timer); reject(error); } },
    );
  });
}
