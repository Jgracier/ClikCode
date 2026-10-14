/** The one normalizer: every `HarnessActivityEvent`, from whichever harness,
 * passes through `normalizeActivityEvent` before a surface or the saved turn
 * sees it (`turnSink.activity`, `BroadcastObserver.activityEvent`,
 * `readTurnActivities`). Adapters supply FACTS (name, input, status, output,
 * exit code); this decides what the row says and how it is classified, so
 * the same logical call is the same event whichever vendor made it
 * (docs/TURN_FLOW_STANDARD.md, "Look").
 *
 * The rules, in one place:
 *  - category: from a reported diff, else the call's own name/input
 *    (`toolCategory`, the shared table in tools.ts), else the verb the label
 *    already starts with (`$ `, `Read `, `Edit `, ...). MCP and other tools
 *    nothing classifies stay without a category (their row is still drawn
 *    with the shared glyph; a folded run counts them as "steps") -- never a
 *    guessed one.
 *  - label: the Claude Code shape every harness is held to -- `$ <command>`,
 *    `<Verb> <path>`, `Agent <task>`, `server › tool`. A label that is not
 *    that shape is rebuilt from the call when the call is known
 *    (`toolLabel`), or from its `Name(detail)` / backticked-command form.
 *    `tool` (a completion frame's placeholder) is left to the merge.
 *  - lifecycle: a command that reports a non-zero exit is an error, not a
 *    done; durations and exit codes are finite numbers or absent; a
 *    sub-agent's call is `agent: true`.
 *  - output: at most OUTPUT_LINES lines of CLIPPED lines; a command keeps its
 *    tail (with its head and the omitted count), anything else its start.
 *  - thought: the one folded, capped shape (`thoughtLabel`).
 * Pure and idempotent; an event already in shape is returned as the same
 * object. */

import type { HarnessActivityEvent, ToolCategory } from '../prompter.js';
import { thoughtLabel } from './activity-events.js';
import { COMMAND_HEAD_LINES } from './activity-view.js';
import { formatToolRow, isAgentToolName, toolCategory, toolLabel } from './tools.js';

/** Lines of output an event carries (the same bound the producers and the
 * saved turn use). */
export const OUTPUT_LINES = 60;
/** Characters of one output line kept. */
const OUTPUT_LINE_CHARS = 400;

/** The verb each category's row starts with, as `formatToolRow` writes it. */
const CANONICAL_LABEL: Readonly<Record<ToolCategory, RegExp>> = {
  run: /^\$ /,
  read: /^Read(?: |$)/,
  edit: /^(?:Edit|Write|Delete)(?: |$)/,
  search: /^(?:Glob|Grep|List|Search)(?: |$)/,
  fetch: /^(?:Fetch|Web search)(?: |$)/,
};

/** The category a label's own verb says (what `formatToolRow` wrote). */
function categoryFromLabel(label: string): ToolCategory | undefined {
  for (const category of Object.keys(CANONICAL_LABEL) as ToolCategory[]) if (CANONICAL_LABEL[category].test(label)) return category;
  const called = /^([A-Za-z_][\w-]*)\(/.exec(label);
  return called ? toolCategory(called[1]!) : undefined;
}

function categoryFor(event: HarnessActivityEvent): ToolCategory | undefined {
  if (event.category) return event.category;
  if (event.agent) return undefined;
  if (event.diff?.length) return 'edit';
  if (event.call) {
    const named = toolCategory(event.call.name, event.call.input);
    if (named) return named;
  }
  return categoryFromLabel(event.label);
}

function labelFor(event: HarnessActivityEvent, category: ToolCategory | undefined): string {
  const { label } = event;
  if (!label || label === 'tool') return label;
  if (event.agent) {
    // `Task(review)` and `Agent review` are one row: the latter.
    const called = /^([A-Za-z_][\w-]*)\((.*)\)$/s.exec(label);
    return called && isAgentToolName(called[1]!) ? formatToolRow('agent', called[2]) : label;
  }
  if (!category) return label;
  // The call is known: the row is built from it, as every parser does, so the
  // same call reads the same however an adapter spelled its title. Only with
  // an id, so frames that merge by label all say the same thing.
  if (event.call && event.id) {
    const built = toolLabel(event.call.name, event.call.input, category);
    if (built !== formatToolRow(event.call.name, undefined, category)) return built;
  }
  if (CANONICAL_LABEL[category].test(label)) return label;
  // `Bash(ls)`, `Read(src/a.ts)`: the vendor's own spelling of the row.
  const called = /^([A-Za-z_][\w-]*)\((.*)\)$/s.exec(label);
  if (called) return formatToolRow(called[1]!, called[2], category);
  // An ACP agent's title for a command: `` `npm test` ``.
  const ticked = /^`([^`\n]+)`$/.exec(label);
  if (ticked) return formatToolRow('shell', ticked[1], category);
  return label;
}

function boundedOutput(event: HarnessActivityEvent, category: ToolCategory | undefined): Partial<HarnessActivityEvent> | undefined {
  const lines = event.output;
  if (!lines?.length) return undefined;
  const clipped = lines.some((line) => line.length > OUTPUT_LINE_CHARS);
  if (lines.length <= OUTPUT_LINES && !clipped) return undefined;
  const clip = (line: string): string => (line.length > OUTPUT_LINE_CHARS ? `${line.slice(0, OUTPUT_LINE_CHARS - 1)}…` : line);
  const fromEnd = event.outputTail === true || (category === 'run' && !event.outputOmitted);
  const kept = (fromEnd ? lines.slice(-OUTPUT_LINES) : lines.slice(0, OUTPUT_LINES)).map(clip);
  const dropped = lines.length - kept.length;
  return {
    output: kept,
    ...(dropped || event.outputOmitted ? { outputOmitted: (event.outputOmitted ?? 0) + dropped } : {}),
    ...(fromEnd ? { outputTail: true as const } : {}),
    ...(fromEnd && dropped && !event.outputHead ? { outputHead: lines.slice(0, COMMAND_HEAD_LINES).map(clip) } : {}),
  };
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function normalizeActivityEvent<T extends HarnessActivityEvent>(event: T): T {
  if (event.kind === 'thinking') {
    const label = thoughtLabel(event.label);
    return label === event.label ? event : { ...event, label };
  }
  const agent = event.agent || (event.call && (isAgentToolName(event.call.name) || typeof event.call.input?.subagent_type === 'string')) ? true : undefined;
  const base = agent && !event.agent ? { ...event, agent } : event;
  const category = categoryFor(base);
  const label = labelFor(base, category);
  const failedExit = base.kind === 'tool-done' && !base.stopped && category === 'run' && finite(base.exitCode) && base.exitCode !== 0;
  const output = boundedOutput(base, category);
  const next: HarnessActivityEvent = {
    ...base,
    ...(category && !base.category ? { category } : {}),
    ...(label !== base.label ? { label } : {}),
    ...(failedExit ? { kind: 'tool-error' as const } : {}),
    ...output,
  };
  if (next.exitCode !== undefined && !finite(next.exitCode)) delete next.exitCode;
  if (next.durationMs !== undefined && (!finite(next.durationMs) || next.durationMs < 0)) delete next.durationMs;
  const same = next.category === event.category && next.label === event.label && next.kind === event.kind && next.agent === event.agent
    && next.output === event.output && next.exitCode === event.exitCode && next.durationMs === event.durationMs;
  return (same ? event : next) as T;
}

/** The same, for a list that may hold nothing but the shared shape already:
 * the same array when no event changed. */
export function normalizeActivityEvents<T extends HarnessActivityEvent>(events: readonly T[]): readonly T[] {
  const next = events.map(normalizeActivityEvent);
  return next.every((event, index) => event === events[index]) ? events : next;
}

