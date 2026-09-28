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
import { MENTIONS_TASK_TOOL, MENTIONS_TODO_TOOL, TaskListTracker, planFromRecord } from '../protocol/plan-events.js';
import { nativeSelfReportFromLine, type NativeSelfReport } from '../protocol/turn-usage.js';
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
}

/** Report one stdout line. Returns only what the turn loop still has to do
 * itself. */
export function reportStructuredLine(
  harness: AiLocalHarnessDefinition, lineText: string, observer: HarnessTurnObserver,
  /** This turn attempt's own stream position (adapters.ts createStreamState). */
  turn?: StreamState,
): StructuredLineOutcome {
  const parsed = parseHarnessLine(harness, lineText, turn);
  const outcome: StructuredLineOutcome = {
    live: Boolean(parsed.sessionId || parsed.response || parsed.activities?.length),
    ...(parsed.error ? { error: parsed.error } : {}),
    ...(parsed.result ? { result: parsed.result } : {}),
  };
  if (parsed.sessionId) void observer.onSessionId?.(parsed.sessionId);
  if (parsed.response) observer.onResponseDelta?.(parsed.response.text, parsed.response.mode);
  if (parsed.phase) observer.onPhase?.(parsed.phase);
  if (parsed.usage) observer.onUsage?.(parsed.usage);
  for (const event of parsed.activities ?? []) observer.onActivity?.(event);
  // A structured CLI writes its todo list with a tool (TodoWrite, write_todos, ...); show it as the plan.
  // Claude Code's task tools build it a call at a time; the tracker keeps the turn's list.
  if (observer.onPlan && MENTIONS_TASK_TOOL.test(lineText)) {
    const plan = trackerFor(observer, turn).apply(parseRecord(lineText));
    if (plan) observer.onPlan(plan);
  } else if (observer.onPlan && MENTIONS_TODO_TOOL.test(lineText)) {
    const plan = planFromLine(lineText);
    if (plan) observer.onPlan(plan);
  }
  const selfReport = nativeSelfReportFromLine(lineText);
  if (selfReport) {
    if (selfReport.commands?.length) observer.onAvailableCommands?.(selfReport.commands);
    outcome.selfReport = selfReport;
  }
  return outcome;
}

/** One task list per turn: on the turn's stream state when there is one, else per observer. */
const trackers = new WeakMap<object, TaskListTracker>();
function trackerFor(observer: HarnessTurnObserver, turn: StreamState | undefined): TaskListTracker {
  const key: object = turn ?? observer;
  let tracker = trackers.get(key);
  if (!tracker) trackers.set(key, (tracker = new TaskListTracker()));
  return tracker;
}

function parseRecord(lineText: string): unknown {
  try {
    const value: unknown = JSON.parse(lineText.trim());
    // A sub-agent's own tasks (Claude's parent_tool_use_id) are not the session's list.
    return value && typeof value === 'object' && (value as { parent_tool_use_id?: unknown }).parent_tool_use_id ? undefined : value;
  } catch {
    // fail-open-ok: a line that is not JSON carries no task change; the adapters already ignore it.
    return undefined;
  }
}

/** The todo list a JSON stream line carries, if any. */
function planFromLine(lineText: string): ReturnType<typeof planFromRecord> {
  const candidate = lineText.trim();
  if (candidate[0] !== '{') return undefined;
  try {
    const value: unknown = JSON.parse(candidate);
    // A sub-agent's own list (Claude's parent_tool_use_id) is not the session's plan.
    if (value && typeof value === 'object' && (value as { parent_tool_use_id?: unknown }).parent_tool_use_id) return undefined;
    return planFromRecord(value);
  } catch {
    // fail-open-ok: a line that is not JSON carries no plan; the adapters already ignore it.
    return undefined;
  }
}
