/** Who the host may delegate to: an account that can take a turn and whose
 * vendor reports an amount still left, the seats ranked by it. An account
 * whose vendor reports nothing is not offered -- there is no amount to rank
 * or show. */

import type { AiHarnessAccount } from '../harness/definition.js';
import { accountCanTakeTurn, usageReadingIsCurrent, vendorWindows } from '../harness/accounts/usage-reading.js';

export interface ClerkUsage {
  /** The tightest remaining percent across the windows that can stop the account. */
  leftPct: number;
}

export function clerkUsage(account: AiHarnessAccount, at: number = Date.now()): ClerkUsage | undefined {
  if (!accountCanTakeTurn(account, at)) return undefined;
  const windows = vendorWindows(account);
  if (!windows.length || !usageReadingIsCurrent({ windows }, at)) return undefined;
  const binding = windows.filter((window) => !window.advisory);
  const measured = binding.length ? binding : windows;
  const leftPct = Math.min(...measured.map((window) => Math.max(0, 100 - window.usedPct)));
  if (leftPct <= 0) return undefined;
  return { leftPct };
}
