/** Who the host may delegate to: a provider that has published a usage window
 * with a numeric amount, and still has some of that amount left. A signed-in
 * account with no reading, or only a learned guess, is not in the pool. */

import type { AiHarnessAccount } from '../harness/definition.js';
import { accountCanTakeTurn, usageReadingIsCurrent, type AccountUsageReading } from '../harness/accounts/usage-reading.js';

export interface ClerkUsage {
  /** The tightest remaining percent across the windows that can stop the account. */
  leftPct: number;
}

export function clerkUsage(account: AiHarnessAccount, now = Date.now()): ClerkUsage | undefined {
  const reading = account.usage as AccountUsageReading | undefined;
  if (!reading || reading.failed) return undefined;
  const windows = (reading.windows ?? []).filter((window) => typeof window.usedPct === 'number' && Number.isFinite(window.usedPct));
  if (!windows.length || !usageReadingIsCurrent({ windows }, now)) return undefined;
  if (!accountCanTakeTurn(account, now)) return undefined;
  const binding = windows.filter((window) => !window.advisory);
  const measured = binding.length ? binding : windows;
  const leftPct = Math.min(...measured.map((window) => Math.max(0, 100 - window.usedPct)));
  if (leftPct <= 0) return undefined;
  return { leftPct };
}
