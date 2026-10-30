/** Moving a conversation off an account before the vendor refuses it -- on a usage reading, and
 * only when the reading can be believed and the move is plainly worth it.
 *
 * A chat never left its account on a reading alone: readings lag (2026-10: Claude's /usage said
 * "weekly 100%" after the user had reset the limit, and the chat kept leaving an account that
 * worked), and an account at 99% is "fine" by windowSpent (usedPct >= 100). Then three parallel
 * agents were started on an account with 1% left and all three died on its limit, and the turn
 * that followed spent 139 s being refused by it.
 *
 * Both are answered without a threshold chosen in advance. The question is not "is the account
 * nearly out" but "will what this turn is about to do fit in what is left", and what a turn costs is
 * measured on the account itself:
 *
 *   burn per turn  =  % of the window used  /  turns ClikCode ran on the account since the window opened
 *
 * (the window opens one window-length before its reset; the turns are the account's invocation
 * records, state.invocations). Usage made elsewhere is counted as ours, so the figure runs high and
 * the margin errs toward moving; the other half of the rule keeps that cheap: a conversation moves
 * only to an account whose own room exceeds the current one's by that same margin -- never to one with
 * less, and never to one that is not clearly better. A turn that starts more than itself (agents it runs in
 * parallel) needs `turns` of that burn.
 *
 * A reading that is not current does not move anything: no window past its reset (it describes
 * last period), and its age within USAGE_RECHECK_MS (the vendor said it a moment ago, not hours). */
import { USAGE_RECHECK_MS, usageReadingIsCurrent, usageWindowMinutes, vendorWindows, type UsageWindow } from '../harness/accounts/usage-reading.js';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessState } from '../session/model.js';

/** Whether the vendor's reading of `account` can be believed now. */
function readingIsFresh(account: AiHarnessAccount, now: number): boolean {
  const at = Date.parse(account.usage?.at ?? '');
  const windows = vendorWindows(account).filter((window) => !window.advisory);
  return Number.isFinite(at) && now - at <= USAGE_RECHECK_MS && windows.length > 0 && usageReadingIsCurrent({ windows }, now);
}

/** What `account` loses per turn in `window`, in percent of the window; undefined when it cannot
 * be measured (no length for the window, no reset to place it, or no turn of ours in it). */
export function burnPerTurn(account: AiHarnessAccount, window: UsageWindow, invocations: HarnessState['invocations'], now: number): number | undefined {
  const minutes = usageWindowMinutes(window.name);
  const resets = Date.parse(window.resetsAt ?? '');
  if (!minutes || !Number.isFinite(resets)) return undefined;
  const opened = resets - minutes * 60_000;
  const turns = invocations.filter((item) => item.accountId === account.id && item.kind !== 'maintenance'
    && Date.parse(item.at) >= opened && Date.parse(item.at) <= now).length;
  if (window.usedPct <= 0) return 0;
  return turns > 0 ? window.usedPct / turns : undefined;
}

/** The room left in `account`'s tightest window, from a reading that can be believed now; undefined
 * when it cannot. */
function currentRoom(account: AiHarnessAccount, now: number): number | undefined {
  if (!readingIsFresh(account, now)) return undefined;
  return Math.min(...vendorWindows(account).filter((window) => !window.advisory).map((window) => Math.max(0, 100 - window.usedPct)));
}

/** What `turns` more turns cost `account`, in percent of a window: the largest burn of its windows, times
 * `turns`. Undefined when any window's burn cannot be measured. */
function costOf(account: AiHarnessAccount, invocations: HarnessState['invocations'], turns: number, now: number): number | undefined {
  let cost = 0;
  for (const window of vendorWindows(account).filter((item) => !item.advisory)) {
    const burn = burnPerTurn(account, window, invocations, now);
    if (burn === undefined) return undefined;
    cost = Math.max(cost, burn * turns);
  }
  return cost;
}

/** The account to move to before a turn that will need `turns` turns' worth of the current one, or
 * undefined. `candidates` are the accounts a failover could use, best first. The candidate's own burn
 * is not asked for (it may never have run here): the turn is assumed to cost it what it costs `current`. */
export function earlyMoveTarget(
  current: AiHarnessAccount, candidates: readonly AiHarnessAccount[], invocations: HarnessState['invocations'], options: { now: number; turns: number },
): AiHarnessAccount | undefined {
  const { now, turns } = options;
  const room = currentRoom(current, now);
  const cost = costOf(current, invocations, turns, now);
  // Room enough for what is coming, or no reading to say it is not.
  if (room === undefined || cost === undefined || room >= cost) return undefined;
  // Clearly more room: more by what the turn costs, so it fits there with the margin it lacks here.
  return candidates.find((candidate) => (currentRoom(candidate, now) ?? Number.NEGATIVE_INFINITY) >= room + cost);
}
