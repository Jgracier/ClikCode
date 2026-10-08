/** A manual account change while a turn is running.
 *
 * The user's pick is written to the session record at once, by whichever
 * process handled the command (the window, the editor's bridge), so the
 * status line shows it. The turn runs in the conversation's worker, another
 * process: it learns of the pick from that record, at the next call boundary
 * -- the next model step, or the moment a vendor tool call settles and
 * nothing else is open -- and moves the thread there. A note kept in one
 * process's memory cannot reach the other, which is how a thread was once
 * left in an account's profile the conversation no longer used. Automatic
 * quota failover does not come through here. */

import type { AiHarnessAccount } from '../harness/definition.js';

const MANUAL_ACCOUNT_SWITCH = 'ERR_MANUAL_ACCOUNT_SWITCH';

export function manualAccountSwitchError(): Error & { code: string } {
  return Object.assign(new Error('account switched'), { code: MANUAL_ACCOUNT_SWITCH });
}

export function isManualAccountSwitch(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === MANUAL_ACCOUNT_SWITCH;
}

/** One abort follows two signals. A manual switch aborts with its own
 * reason, so a turn can tell it from the user stopping the conversation. */
export function linkAbortSignals(outer: AbortSignal | undefined, inner: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const follow = (signal: AbortSignal): void => {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  };
  if (outer) follow(outer);
  follow(inner);
  return controller.signal;
}

/** The account the user picked since the turn last looked, or undefined.
 *
 * `recorded` is the account the session record names now. `seen` is the
 * record's account when the turn last acknowledged it (at its start, and each
 * time the record caught up with the turn's own account): only a record that
 * differs from `seen` and from the turn's account is a pick. The turn's own
 * failover writes its new account to the record, so until that write lands
 * the record still names the account the turn left -- unchanged from `seen`,
 * and so never mistaken for the user going back to it. */
export function pickedAccount(input: {
  recorded: string | null | undefined;
  seen: string;
  current: AiHarnessAccount;
  accounts: readonly AiHarnessAccount[];
  canRun: (account: AiHarnessAccount) => boolean;
}): AiHarnessAccount | undefined {
  const { recorded } = input;
  if (!recorded || recorded === input.seen || recorded === input.current.id) return undefined;
  const to = input.accounts.find((item) => item.id === recorded);
  return to && input.canRun(to) ? to : undefined;
}
