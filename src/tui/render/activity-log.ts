/** The activity log: one entry per tool call or assistant turn, upserted as
 * events arrive and rebased when the transcript above it grows. */

import chalk from 'chalk';
import { sanitizeTerminalText } from './text.js';
import { visibleSlice } from './width.js';
import { renderActivityLine } from '../../harness/protocol/activity-line.js';
import type { HarnessActivityEvent, ToolCategory } from '../../harness/prompter.js';
import { TOOL_CATEGORY_STYLE } from '../../harness/protocol/tool-category-style.js';
import { isAgentToolName } from '../../harness/protocol/tools.js';

/** One rendered activity row and where it belongs: the message index it was
 * reported under, and -- for a row produced inside a turn -- the response
 * offset it started at, which is where it is written back into the prose.
 * `startedAt` is when the call was first seen, for its running timer. */
export type ActivityEntry = {
  anchor: number; responseOffset?: number; sequence?: number; startedAt?: number;
  event?: HarnessActivityEvent; lines: string[];
};

/** One provider may publish pending/running/progress frames for the same tool.
 * They describe one lifecycle, not separate calls. Upsert by native id, or by
 * the latest still-open matching label when a protocol omits ids. */
export function upsertActivityEvent(
  entries: readonly ActivityEntry[], anchor: number, responseOffset: number | undefined, event: HarnessActivityEvent, sequence?: number,
  now = Date.now(),
): ActivityEntry[] {
  // A thought is never a transcript row: reasoning summaries arrive dozens per
  // turn and would bury the answer. The prompter shows the latest one on a
  // single live row instead (see TerminalHarnessPrompter.activityEvent).
  if (event.kind === 'thinking') return [...entries];
  // Tool labels, output and diffs are untrusted text. They are cleaned before
  // renderActivityLine styles them, so the only escapes left in a row are the
  // color codes this UI added itself.
  const cleanLines = (lines: readonly string[]): string[] => lines.map((line) => sanitizeTerminalText(line, { singleLine: true }));
  const normalized: HarnessActivityEvent = {
    ...event,
    label: visibleSlice(sanitizeTerminalText(event.label, { singleLine: true }).replace(/\s+/g, ' ').trim() || 'tool', 120),
    ...(event.output ? { output: cleanLines(event.output) } : {}),
    ...(event.diff ? { diff: { ...event.diff, removed: cleanLines(event.diff.removed), added: cleanLines(event.diff.added) } } : {}),
  };
  const matchIndex = (() => {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      if (entry.anchor !== anchor || !entry.event) continue;
      // By id, a call's row is found whatever state it is in: detail that
      // arrives after it finished (a final diff) belongs in that row, not a
      // new one. Without an id only an open row can be the same call.
      if (normalized.id) { if (entry.event.id === normalized.id) return index; continue; }
      if (entry.event.kind === 'tool-start' && entry.event.label === normalized.label) return index;
    }
    return -1;
  })();
  const next = [...entries];
  if (matchIndex >= 0) {
    const prior = next[matchIndex]!;
    const effective = {
      ...normalized,
      // A finished call stays finished: a later frame without a status adds
      // its detail but cannot reopen it.
      ...(normalized.kind === 'tool-start' && prior.event!.kind !== 'tool-start' ? { kind: prior.event!.kind } : {}),
      ...(normalized.label === 'tool' ? { label: prior.event!.label } : {}),
      // A completion frame routinely carries neither the name nor the input
      // the category was derived from. The row keeps what its start knew.
      ...(normalized.category ? {} : prior.event?.category ? { category: prior.event.category } : {}),
      ...(normalized.agent ? {} : prior.event?.agent ? { agent: prior.event.agent } : {}),
      ...(normalized.diff ? {} : prior.event?.diff ? { diff: prior.event.diff } : {}),
      // Likewise its output: a completion that carries none (most do not)
      // used to erase every line the running tool had streamed.
      ...(normalized.output?.length || !prior.event?.output?.length ? {} : {
        output: prior.event.output,
        ...(prior.event.outputOmitted ? { outputOmitted: prior.event.outputOmitted } : {}),
        ...(prior.event.outputTail ? { outputTail: true } : {}),
      }),
    };
    next[matchIndex] = { ...prior, event: effective, lines: renderActivityLine(effective).map((line) => line.trim()) };
  } else {
    next.push({
      anchor, ...(responseOffset === undefined ? {} : { responseOffset }), ...(sequence === undefined ? {} : { sequence }),
      startedAt: now, event: normalized, lines: renderActivityLine(normalized).map((line) => line.trim()),
    });
  }
  // Do not evict old entries here. Some may already be immutable native
  // scrollback; removing one would invalidate the rendered prefix and force a
  // full-screen reset. No entry is ever collapsed into a count either: a row
  // whose text can still change could never enter scrollback at all.
  return next;
}

/** A replacement stream is usually a cumulative snapshot. Offsets within its
 * unchanged prefix remain valid; offsets in rewritten text do not, so attach
 * those events at the divergence boundary instead of leaving them beyond or
 * inside unrelated prose. */
export function rebaseActivityOffsets(
  entries: readonly ActivityEntry[], anchor: number, previous: string, replacement: string,
): ActivityEntry[] {
  let commonPrefix = 0;
  const shared = Math.min(previous.length, replacement.length);
  while (commonPrefix < shared && previous[commonPrefix] === replacement[commonPrefix]) commonPrefix += 1;
  return entries.map((entry) => entry.anchor === anchor && entry.responseOffset !== undefined
    && entry.responseOffset > commonPrefix
    ? { ...entry, responseOffset: commonPrefix }
    : entry);
}

type OpenTool = { label: string; category?: ToolCategory; agent?: boolean };

/** What the status line says while a call runs: the category's verb, and
 * what it is working on when the label names it -- `Read(src/app.ts)` is
 * "reading app.ts", `Bash(npm test)` is "running tests", a codex command
 * label `git status` is "running git". A label that names nothing gets the
 * bare verb rather than a guess. */
export function toolStatusVerb(tool: OpenTool): string {
  const name = tool.label.split('(')[0]!.trim();
  if (tool.agent || (tool.category !== 'run' && isAgentToolName(tool.label))) return 'waiting on agent';
  const argument = /^[^(]*\((.*)\)$/s.exec(tool.label)?.[1]?.trim();
  const subject = (value: string, width = 32): string => visibleSlice(value, width);
  switch (tool.category) {
    case 'run': {
      const command = argument ?? tool.label;
      if (/(?:^|[\s/])(?:test|tests|vitest|jest|pytest|mocha|rspec|phpunit)\b|\btest:/.test(command)) return 'running tests';
      const program = command.split(/\s+/).find((word) => word && !/^\w+=/.test(word) && word !== 'sudo');
      return program ? `running ${subject(program.split('/').pop() || program, 24)}` : 'running';
    }
    case 'read':
    case 'edit': {
      const verb = TOOL_CATEGORY_STYLE[tool.category].verb;
      const path = argument?.split(/[\s,]+/)[0];
      const file = path?.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
      return file ? `${verb} ${subject(file)}` : verb;
    }
    case 'search':
    case 'fetch':
      return TOOL_CATEGORY_STYLE[tool.category].verb;
    default:
      return name ? `running ${subject(name, 24)}` : 'running';
  }
}

/** Derive the status from the whole in-flight tool set rather than the most
 * recent provider event. A reasoning summary or one parallel completion must
 * not claim the agent is merely thinking while another tool is still live. */
export function activityLifecyclePhase(
  activeTools: ReadonlyMap<string, OpenTool>, event: HarnessActivityEvent,
): { activeTools: Map<string, OpenTool>; phase: string; category?: ToolCategory } {
  const next = new Map(activeTools);
  const key = event.id ?? event.label;
  if (event.kind === 'tool-start') {
    // A progress frame for an open call (more output, a status beat) often
    // carries no name -- the placeholder "tool" -- and no category. It keeps
    // what the call's start said, or the band went from "running tests" to
    // "running tool" the moment output arrived.
    const prior = event.id ? next.get(key) : undefined;
    next.set(key, {
      label: event.label === 'tool' && prior ? prior.label : event.label,
      ...(event.category ?? prior?.category ? { category: (event.category ?? prior?.category)! } : {}),
      ...(event.agent || prior?.agent ? { agent: true } : {}),
    });
  }
  else if (event.kind === 'tool-done' || event.kind === 'tool-error') {
    if (!next.delete(key) && !event.id) {
      const matchingKey = [...next].reverse().find(([, tool]) => tool.label === event.label)?.[0];
      if (matchingKey) next.delete(matchingKey);
    }
  }
  const running = [...next.values()];
  const current = running[running.length - 1];
  if (!current) return { activeTools: next, phase: 'thinking' };
  // The newest open call is what the status line names.
  return {
    activeTools: next, phase: toolStatusVerb(current),
    ...(current.category ? { category: current.category } : {}),
  };
}

/** Fold a run of same-kind tool rows that have nothing to show into one.
 *
 * A turn that reads six files spent up to seventy rows saying so, and the
 * answer those reads were serving fell off the bottom of the screen. Reads
 * carry no preview (their row already names the file), so six of them in a
 * row are six near-identical lines -- one line that says "read 6 files" is
 * the same information in a twelfth of the space.
 *
 * Only rows with no output, no diff and no failure are folded: anything with
 * something to show, or that went wrong, stays on its own row where it can be
 * read. Fewer than two in a row is left exactly as it was -- a summary that
 * says "1 file" is worse than the filename.
 */
export function collapseToolRuns(entries: readonly ActivityEntry[]): ActivityEntry[] {
  // Foldable is about what the row SHOWS, not what the event carried: a read
  // whose output is budgeted away renders as one line, and one line is what
  // can be folded. Judging by the event instead kept rows apart that were
  // already identical on screen.
  const foldable = (entry: ActivityEntry): boolean => Boolean(
    entry.event?.kind === 'tool-done' && entry.event.category && entry.lines.length <= 1,
  );
  const result: ActivityEntry[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (!foldable(entry)) { result.push(entry); continue; }
    const category = entry.event!.category!;
    let end = index;
    while (end + 1 < entries.length) {
      const next = entries[end + 1]!;
      if (!foldable(next) || next.event!.category !== category || next.anchor !== entry.anchor) break;
      end += 1;
    }
    const count = end - index + 1;
    if (count < 2) { result.push(entry); continue; }
    const { paint, glyph, folded } = TOOL_CATEGORY_STYLE[category];
    result.push({ ...entry, lines: [`  ${paint(glyph)} ${chalk.dim(folded(count))}`] });
    index = end;
  }
  return result;
}

export function transientAssistantRequired(
  liveResponse: string, waiting: boolean, transcriptLength: number, entries: readonly ActivityEntry[],
  /** The last persisted message, when it is an assistant reply and no turn is
   * in flight. The finished answer, in other words. */
  settledAssistant?: string,
): boolean {
  // The live slot and the transcript hold the same answer for a moment at the
  // end of a turn: checkpoint.complete() folds the response into
  // session.messages, but liveResponse is only cleared by the next
  // authoritative render(). Any paint in between -- stopWaiting() does one --
  // drew the reply twice, once from the transcript and once from the stream.
  // Drawing a live copy of an answer that is already saved is never right.
  //
  // What gets persisted (checkpoint.complete's `result.text`, the vendor's own
  // final field) and what streamed live (`liveResponse`, built by appendText
  // inserting a blank line between text blocks a tool call split apart) are
  // not always byte-identical even for the exact same answer -- only their
  // whitespace differs. An exact/suffix match on the raw strings missed every
  // multi-block reply (any answer with at least one tool call before its last
  // words, which is nearly all of them), so this compares with runs of
  // whitespace collapsed: the real content matches, only the formatting used
  // to join it differed.
  if (liveResponse && !waiting && settledAssistant !== undefined) {
    const normalize = (value: string): string => value.trim().replace(/\s+/g, ' ');
    const live = normalize(liveResponse);
    const settled = normalize(settledAssistant);
    if (live && (settled === live || settled.endsWith(live))) return false;
  }
  return Boolean(liveResponse || (waiting && entries.some((entry) =>
    entry.anchor === transcriptLength && entry.responseOffset !== undefined)));
}
