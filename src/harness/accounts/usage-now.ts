/** The one usage figure an account has right now.
 *
 * A vendor reading wins while it is current and did not fail. A failed probe
 * is skipped. A learned figure, mature enough to publish, fills that gap and
 * is what the account has until the vendor answers again. Neither means the
 * account is out of usage for anything that needs an amount. */

import type { AiHarnessAccount } from '../definition.js';
import type { HarnessState } from '../../session/model.js';
import { learnedUsageReading } from './usage-learning.js';
import { usageReadingIsCurrent, type AccountUsageReading, type UsageReading, type UsageWindow } from './usage-reading.js';

export interface ResolvedUsage extends UsageReading {
  learned: boolean;
}

type StoredUsage = AccountUsageReading & { learned?: boolean };

function numericWindows(windows: readonly UsageWindow[] | undefined): UsageWindow[] {
  return (windows ?? []).filter((window) => typeof window.usedPct === 'number' && Number.isFinite(window.usedPct));
}

/** Learned usage, or nothing when the history cannot be read. An error here
 * is skipped: it is not a number and it does not wipe a vendor reading. */
export function learnedUsageNow(account: AiHarnessAccount, state: HarnessState, now = Date.now()): UsageReading | undefined {
  try {
    return learnedUsageReading(account.usageLearning, state.invocations ?? [], account.id, now);
  } catch {
    return undefined;
  }
}

/** Vendor windows when the last reading succeeded and still describes this
 * period. Otherwise the learned figure. Otherwise nothing. */
export function resolvedUsage(account: AiHarnessAccount, state: HarnessState, now = Date.now()): ResolvedUsage | undefined {
  const stored = account.usage as StoredUsage | undefined;
  if (stored && !stored.failed && !stored.learned) {
    const windows = numericWindows(stored.windows);
    if (windows.length && usageReadingIsCurrent({ windows }, now)) {
      return { windows, ...(stored.label === undefined ? {} : { label: stored.label }), learned: false };
    }
  }
  const learned = learnedUsageNow(account, state, now);
  if (!learned?.windows.length) return undefined;
  return { windows: learned.windows, ...(learned.label === undefined ? {} : { label: learned.label }), learned: true };
}

/** Write the learned figure onto the account when the vendor has not already
 * published a current one. A later vendor reading replaces it by simply being
 * newer and not marked learned. */
export function publishLearnedUsage(account: AiHarnessAccount, state: HarnessState, now = Date.now()): UsageReading | undefined {
  const stored = account.usage as StoredUsage | undefined;
  const vendor = stored && !stored.failed && !stored.learned ? numericWindows(stored.windows) : [];
  if (vendor.length && usageReadingIsCurrent({ windows: vendor }, now)) return undefined;
  const learned = learnedUsageNow(account, state, now);
  if (!learned?.windows.length) return undefined;
  account.usage = {
    at: new Date(now).toISOString(),
    ...(learned.label === undefined ? {} : { label: learned.label }),
    learned: true,
    windows: learned.windows,
  } as AiHarnessAccount['usage'];
  return learned;
}
