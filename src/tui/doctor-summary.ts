/** What `doctor` prints: the state of every harness, account and session in
 * one screen. */

import { inspectNativeHarnessForPicker } from '../harness/transport/native/inspect.js';
import type { HarnessState } from '../session/model.js';
import { compactPath } from '../harness/protocol/labels.js';
import { harnessStatePath } from '../session/state/paths.js';
import { allLocalHarnesses, harnessCanRunTurns } from '../runtime/lazy-bridge.js';
import { integrationLabel } from '../session/options.js';

/** Human-readable health summary for the TUI (the headless /doctor is JSON). */
export async function doctorSummary(state: HarnessState): Promise<string> {
  const harnesses = allLocalHarnesses().filter((harness) => harnessCanRunTurns(harness));
  const inspections = await Promise.all(harnesses.map(async (harness) => ({ harness, inspection: await inspectNativeHarnessForPicker(harness) })));
  const installed = inspections.filter((item) => item.inspection.installed);
  return [
    `Installed harnesses (${installed.length}/${inspections.length})`,
    ...installed.map(({ harness, inspection }) => `  ${harness.displayName}${inspection.version ? ` ${inspection.version}` : ''} · ${integrationLabel(harness)}`),
    '',
    `Accounts (${state.accounts.length})`,
    ...(state.accounts.length ? state.accounts.map((account) => `  ${account.label} · ${account.provider} · ${account.status}${account.quotaState === 'exhausted' ? ' · quota exhausted' : ''}`) : ['  none yet — /provider adds one']),
    '',
    `State: ${compactPath(harnessStatePath())}`,
  ].join('\n');
}
