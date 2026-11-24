/** `41k/100k`: how much context the conversation holds against where it compacts -- the
 * auto-tuned level for its model (/compact auto), the fixed number (/compact 150k), or, with
 * compaction off, the model's window. Drawn left of the usage on the composer rule. */
import { compactCount } from '../../harness/protocol/format.js';
import type { HarnessSession } from '../../session/model.js';
import { isClikCodeAgent } from '../../session/route.js';
import { contextTokens, currentCompactAt, effectiveThreshold } from '../../turn/compaction.js';
import { contextThreshold } from '../../turn/context-tune.js';
import { knownVendorMeasures } from '../../turn/vendor-floors.js';
import { quiet } from '../../runtime/lifecycle-log.js';

export function contextGaugeLabel(session: HarnessSession | undefined): string | undefined {
  const usage = session?.lastUsage;
  const used = contextTokens(usage);
  if (!session || used === undefined) return undefined;
  const window = usage?.contextWindow && usage.contextWindow > 0 ? usage.contextWindow : undefined;
  const of = compactPoint(session, window) ?? window;
  return of ? `${count(used)}/${count(of)}` : `${count(used)} context`;
}

/** `1M`, not `1.0M`. */
const count = (tokens: number): string => compactCount(tokens).replace(/\.0(?=[kM])/, '');

/** Where ClikCode compacts this conversation (worker/worker-turn.ts): undefined with compaction off. */
function compactPoint(session: HarnessSession, window: number | undefined): number | undefined {
  if (isClikCodeAgent(session) || !session.nativeHarness) return undefined;
  try {
    const model = session.model ?? session.reported?.model ?? null;
    const known = knownVendorMeasures(session.nativeHarness, model);
    const level = contextThreshold({ compactAt: currentCompactAt() }, session.nativeHarness, model, {
      ...(known.floor !== undefined ? { floor: known.floor } : {}),
      ...(known.window ?? window ? { window: known.window ?? window } : {}),
    });
    return level === undefined ? undefined : effectiveThreshold(level, session.compaction);
  } catch (error) {
    quiet('tui/context-gauge')(error);
    return undefined;
  }
}
