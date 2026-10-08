/** A turn parked until its provider's quota resets ("Wait for reset" in the
 * Resume-in picker; HarnessSession.resumeAt), sent by the conversation's
 * worker once the reset has passed and an account can take it.
 *
 * The parked turn lives on the session, never only in here: a worker that
 * stops (a newer build, a signal) leaves it for whichever worker starts next,
 * which looks at start. While one is parked the worker does not idle out --
 * nobody may be left to open the conversation again. It is sent once: the
 * record is cleared before the turn starts, so running out again ends with a
 * notice, not a loop. A new message or a cancel clears it. */
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { matchesVendorTurn } from '../turn/account-routing.js';
import { resumeStep, type ResumeAt } from '../turn/usage-exhausted.js';

export interface ResumeWaiterHost {
  sessionId: string;
  /** A turn is running: the parked one waits for it, and is looked at again
   * when it ends. */
  turnRunning: () => boolean;
  /** Start the parked turn, as the worker starts any turn. */
  send: (prompt: string) => void;
  notice: (message: string) => void;
  /** Whether one is parked changed: the idle clock re-decides. */
  changed: () => void;
  now?: () => number;
}

export interface ResumeWaiter {
  /** Read the session and act on what is parked there (or no longer is). */
  check(): Promise<void>;
  /** Drop the parked turn; `why` is told to every window when there was one. */
  cancel(why?: string): Promise<void>;
  readonly pending: boolean;
  stop(): void;
}

/** Takes the parked turn off the session, returning it when there was one. */
async function takeResumeAt(sessionId: string): Promise<ResumeAt | undefined> {
  const state = await readState({ transcripts: [] });
  const session = state.sessions.find((item) => item.id === sessionId);
  const parked = session?.resumeAt;
  if (!session || !parked) return undefined;
  delete session.resumeAt;
  await writeState(state);
  return parked;
}

export function createResumeWaiter(host: ResumeWaiterHost): ResumeWaiter {
  const now = host.now ?? Date.now;
  let timer: NodeJS.Timeout | undefined;
  let pending = false;
  /** One look at a time: a check and a cancel racing must not both act. */
  let chain: Promise<void> = Promise.resolve();
  const serial = (step: () => Promise<void>): Promise<void> => {
    chain = chain.then(step, step).catch((error: unknown) => {
      host.notice(`Could not resume after the reset: ${error instanceof Error ? error.message : String(error)}`);
    });
    return chain;
  };
  const setPending = (next: boolean): void => {
    if (pending === next) return;
    pending = next;
    host.changed();
  };
  const clearTimer = (): void => { if (timer) clearTimeout(timer); timer = undefined; };

  const look = async (): Promise<void> => {
    clearTimer();
    const state = await readState({ transcripts: [] });
    const session = state.sessions.find((item) => item.id === host.sessionId);
    const parked = session?.resumeAt;
    if (!session || !parked) { setPending(false); return; }
    setPending(true);
    if (host.turnRunning()) return;
    const step = resumeStep(parked, state.accounts, session.provider, now(), matchesVendorTurn);
    if (typeof step === 'object') {
      // Not unref'd: this timer is what the worker is staying up for.
      timer = setTimeout(() => { void serial(look); }, step.wait);
      return;
    }
    const taken = await takeResumeAt(host.sessionId);
    setPending(false);
    if (!taken) return;
    if (step === 'give-up') { host.notice('Stopped waiting for the reset: no account could take the turn an hour after it'); return; }
    host.send(taken.prompt);
  };

  return {
    check: () => serial(look),
    cancel: (why) => serial(async () => {
      clearTimer();
      const taken = await takeResumeAt(host.sessionId);
      setPending(false);
      if (taken && why) host.notice(why);
    }),
    get pending() { return pending; },
    stop: clearTimer,
  };
}
