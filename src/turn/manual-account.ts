/** A manual account change while a turn is running.
 *
 * The session's account is written at once, so the status line shows it.
 * The vendor process and its thread file stay on the account that opened
 * them until the next call boundary: the next model step, or the moment a
 * vendor tool call settles and nothing else is open. Moving the thread
 * while that process still has it open races the file. Automatic quota
 * failover does not come through here. */

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

interface PendingSwitch { fromId: string; toId: string }

/** The account whose profile still holds the thread, and the account the
 * user picked. `fromId` stays the holder across later picks, until the
 * thread actually moves. */
const pending = new Map<string, PendingSwitch>();

export function noteManualAccountSwitch(sessionId: string, fromId: string, toId: string): void {
  const holder = pending.get(sessionId)?.fromId ?? fromId;
  if (holder === toId) pending.delete(sessionId);
  else pending.set(sessionId, { fromId: holder, toId });
}

export function clearManualAccountSwitch(sessionId: string): void {
  pending.delete(sessionId);
}

export function manualSwitchPending(sessionId: string): PendingSwitch | undefined {
  const move = pending.get(sessionId);
  return move ? { ...move } : undefined;
}

/** Carry the thread onto the account the user picked, when this turn can
 * run that account. The pending note stays when it cannot, for the turn
 * that can. A newer pick that landed during the carry is left in place. */
export async function applyManualAccount(input: {
  sessionId: string;
  accounts: readonly AiHarnessAccount[];
  current: AiHarnessAccount;
  canRun: (account: AiHarnessAccount) => boolean;
  carry: (from: AiHarnessAccount, to: AiHarnessAccount) => Promise<void>;
}): Promise<AiHarnessAccount> {
  const move = pending.get(input.sessionId);
  if (!move) return input.current;
  const to = input.accounts.find((item) => item.id === move.toId);
  const from = input.accounts.find((item) => item.id === move.fromId) ?? input.current;
  if (!to || to.id === from.id || !input.canRun(to)) return input.current;
  await input.carry(from, to);
  if (pending.get(input.sessionId)?.toId === move.toId) pending.delete(input.sessionId);
  return to;
}
