/** Who the host may delegate to. The account needs a numeric amount still
 * left: the vendor's own reading, or the figure learned from its turns.
 * A failed reading is skipped. No amount means out of usage. */

import type { AiHarnessAccount } from '../harness/definition.js';
import { resolvedUsage } from '../harness/accounts/usage-now.js';
import { accountCanTakeTurn } from '../harness/accounts/usage-reading.js';
import type { HarnessState } from '../session/model.js';

export interface ClerkUsage {
  /** The tightest remaining percent across the windows that can stop the account. */
  leftPct: number;
}

export function clerkUsage(account: AiHarnessAccount, stateOrNow: HarnessState | number = Date.now(), now = Date.now()): ClerkUsage | undefined {
  const state = typeof stateOrNow === 'number' ? undefined : stateOrNow;
  const at = typeof stateOrNow === 'number' ? stateOrNow : now;
  if (!accountCanTakeTurn(account, at)) return undefined;
  const reading = resolvedUsage(account, state ?? { invocations: [] } as unknown as HarnessState, at);
  const windows = reading?.windows ?? [];
  if (!windows.length) return undefined;
  const binding = windows.filter((window) => !window.advisory);
  const measured = binding.length ? binding : windows;
  const leftPct = Math.min(...measured.map((window) => Math.max(0, 100 - window.usedPct)));
  if (leftPct <= 0) return undefined;
  return { leftPct };
}
