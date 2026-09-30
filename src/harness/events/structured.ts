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
import { parseHarnessLine, type StreamState } from './adapters.js';
import { MENTIONS_TASK_TOOL, MENTIONS_TODO_TOOL, planFromRecord } from '../protocol/plan-events.js';
import { parseJsonRecord, type JsonRecord } from '../protocol/json-lines.js';
import { nativeSelfReportFromValue, type NativeSelfReport } from '../protocol/turn-usage.js';
import type { HarnessTurnObserver } from './turn-observer.js';
import type { AiLocalHarnessDefinition } from '../definition.js';
import type { HarnessLineError } from './adapters.js';

interface StructuredLineOutcome {
  /** The line carried something a harness only sends once it is really running,
   * which is what confirms a session id that was minted optimistically. */
  live: boolean;
  /** A terminal error the harness reported on the stream. */
  error?: HarnessLineError;
  /** What the harness said about itself: the model it resolved, the permission
   * mode it applied. The caller persists these; the commands go to the
   * observer like anything else it reports. */
  selfReport?: NativeSelfReport;
  /** The line was the vendor's end-of-turn record, and how that turn ended. */
  result?: 'success' | 'error';
  /** The line changed the turn's usage. */
  usage?: boolean;
}

/** Report one stdout line. Returns only what the turn loop still has to do
 * itself. `record` is the line already parsed, for a caller that needed it
 * first; every reader below takes it rather than parsing the text again. */
export function reportStructuredLine(
  harness: AiLocalHarnessDefinition, lineText: string, observer: HarnessTurnObserver,
  /** This turn attempt's own stream position (adapters.ts createStreamState). */
  turn: StreamState,
  record: JsonRecord | undefined = parseJsonRecord(lineText),
): StructuredLineOutcome {
  const parsed = parseHarnessLine(harness, lineText, turn, record);
  const outcome: StructuredLineOutcome = {
    live: Boolean(parsed.sessionId || parsed.response || parsed.activities?.length),
    ...(parsed.error ? { error: parsed.error } : {}),
    ...(parsed.result ? { result: parsed.result } : {}),
    ...(parsed.usage ? { usage: true } : {}),
  };
  if (parsed.sessionId) void observer.onSessionId?.(parsed.sessionId);
  if (parsed.response) observer.onResponseDelta?.(parsed.response.text, parsed.response.mode);
  if (parsed.phase) observer.onPhase?.(parsed.phase);
  if (parsed.usage) observer.onUsage?.(parsed.usage);
  for (const event of parsed.activities ?? []) observer.onActivity?.(event);
  if (!record) return outcome;
  // A structured CLI writes its todo list with a tool (TodoWrite, write_todos, ...); show it as the plan.
  // Claude Code's task tools build it a call at a time; the turn's tracker keeps the list.
  // A sub-agent's own list (Claude's parent_tool_use_id) is not the session's plan.
  if (observer.onPlan && !record.parent_tool_use_id) {
    const plan = MENTIONS_TASK_TOOL.test(lineText) ? turn.tasks.apply(record)
      : MENTIONS_TODO_TOOL.test(lineText) ? planFromRecord(record) : undefined;
    if (plan) observer.onPlan(plan);
  }
  const selfReport = nativeSelfReportFromValue(record);
  if (selfReport) {
    if (selfReport.commands?.length) observer.onAvailableCommands?.(selfReport.commands);
    outcome.selfReport = selfReport;
  }
  return outcome;
}
