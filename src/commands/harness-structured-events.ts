/**
 * One line of a structured CLI's stdout, reported through the shared observer.
 *
 * The structured CLI transport -- twelve of the twenty-four catalogued
 * harnesses, the largest group by some way -- used to be the one transport that
 * reported nothing through a contract. Its lines were parsed inside the turn
 * loop and dispatched straight at the terminal, the checkpoint and the session
 * record from there, so what a harness could report was whatever that one
 * callback happened to handle, and there was nothing to compare against the
 * other transports.
 *
 * The parsing was already in harness-event-adapters; what was missing was the
 * step that turns a parsed line into the same calls every other transport
 * makes. That step is here, and it is the whole of it.
 *
 * What this does NOT do is the caller's bookkeeping -- checkpoints, idle
 * timers, session records, quota probes. Those are returned rather than
 * performed, because they belong to the turn loop and not to a line parser.
 */
import { parseHarnessLine } from './harness-event-adapters.js';
import { nativeSelfReportFromLine, type NativeSelfReport } from './native-harness-protocol.js';
import type { HarnessTurnObserver } from './harness-turn-observer.js';
import type { AiLocalHarnessDefinition } from './types.js';
import type { HarnessLineError } from './harness-event-adapters.js';

export interface StructuredLineOutcome {
  /** The line carried something a harness only sends once it is really running,
   * which is what confirms a session id that was minted optimistically. */
  live: boolean;
  /** A terminal error the harness reported on the stream. */
  error?: HarnessLineError;
  /** What the harness said about itself: the model it resolved, the permission
   * mode it applied. The caller persists these; the commands go to the
   * observer like anything else it reports. */
  selfReport?: NativeSelfReport;
}

/** Report one stdout line. Returns only what the turn loop still has to do
 * itself. */
export function reportStructuredLine(
  harness: AiLocalHarnessDefinition, lineText: string, observer: HarnessTurnObserver,
): StructuredLineOutcome {
  const parsed = parseHarnessLine(harness, lineText);
  const outcome: StructuredLineOutcome = {
    live: Boolean(parsed.sessionId || parsed.response || parsed.activities?.length),
    ...(parsed.error ? { error: parsed.error } : {}),
  };
  if (parsed.sessionId) void observer.onSessionId?.(parsed.sessionId);
  if (parsed.response) observer.onResponseDelta?.(parsed.response.text, parsed.response.mode);
  if (parsed.phase) observer.onPhase?.(parsed.phase);
  if (parsed.usage) observer.onUsage?.(parsed.usage);
  for (const event of parsed.activities ?? []) observer.onActivity?.(event);
  const selfReport = nativeSelfReportFromLine(lineText);
  if (selfReport) {
    if (selfReport.commands?.length) observer.onAvailableCommands?.(selfReport.commands);
    outcome.selfReport = selfReport;
  }
  return outcome;
}
