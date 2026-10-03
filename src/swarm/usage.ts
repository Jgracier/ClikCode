/** Who the host may delegate to: an account that can take a turn with an
 * amount still left -- its vendor's, or for a harness that reports none, the
 * one its refusals have taught -- the seats ranked by it. An account with no
 * amount at all is not offered: there is nothing to rank or show. */

import type { AiHarnessAccount } from '../harness/definition.js';
import { accountCanTakeTurn, usageReadingIsCurrent, vendorWindows } from '../harness/accounts/usage-reading.js';
import { learnedReading } from '../harness/accounts/learned-usage.js';
import type { HarnessState } from '../session/model.js';

export interface ClerkUsage {
  /** The tightest remaining percent across the windows that can stop the account. */
  leftPct: number;
}

export function clerkUsage(account: AiHarnessAccount, at: number = Date.now(), state?: HarnessState): ClerkUsage | undefined {
  if (!accountCanTakeTurn(account, at)) return undefined;
  const vendor = vendorWindows(account);
  const windows = vendor.length || !state ? vendor : learnedReading(state, account, at)?.windows ?? [];
  if (!windows.length || !usageReadingIsCurrent({ windows }, at)) return undefined;
  const binding = windows.filter((window) => !window.advisory);
  const measured = binding.length ? binding : windows;
  const leftPct = Math.min(...measured.map((window) => Math.max(0, 100 - window.usedPct)));
  if (leftPct <= 0) return undefined;
  return { leftPct };
}
