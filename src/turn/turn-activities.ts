/** A turn's tool calls, kept with the turn.
 *
 * The running turn's journal (`pendingTurn.activities`) and the assistant
 * message a finished turn becomes (`messages[i].activities`) hold the same
 * thing: one record per call, merged frame by frame by the rules every client
 * already draws by (activity-view.ts), with the offset into the text where it
 * began. Child calls are kept too, with their parentId, while the UI draws
 * only the parent row. A reopened chat draws rows where they happened; the journal used to
 * keep the last twenty one-line strings, so a reopened chat showed its prose
 * with a blank gap wherever a call had been.
 *
 * Bounded by size: each call keeps enough of its output and diff to draw the
 * same row (the previews show at most a few lines of each, with the rest
 * counted), and a turn keeps at most MAX_TURN_ACTIVITY_BYTES -- trimming the
 * oldest calls' detail first, and dropping whole calls only past that. */

import type { FileDiff } from '../agent/line-diff.js';
import { asFileDiffs } from '../agent/line-diff.js';
import type { HarnessActivityEvent } from '../harness/prompter.js';
import {
  ACTIVITY_PREVIEW_LINES, COMMAND_HEAD_LINES, COMMAND_TAIL_LINES, DIFF_PREVIEW_FILES, DIFF_PREVIEW_LINES,
  mergeActivity, sameCall, withChildTool,
} from '../harness/protocol/activity-view.js';
import type { TranscriptMessage, TurnActivity } from '../session/model.js';

/** Characters of a call's label kept. */
const MAX_LABEL_CHARS = 400;
/** Characters of one output or diff line kept. Rows are clipped to the
 * screen long before this. */
const MAX_LINE_CHARS = 400;
/** Lines of output a call keeps: more than any preview shows, and what
 * another provider taking the conversation over is shown of the call
 * (session/canonical.ts). Measured on 1,749 stored calls: half print at most
 * 5 lines, 90% at most 73, 95% at most 127. At the producer's former 20 a
 * quarter of all calls were cut; 60 keeps the whole output of ~88% of them,
 * at a median 53 characters a line ~3 KB a call. The per-turn bound below
 * still applies (oldest calls trimmed first), so a turn costs no more. */
export const MAX_OUTPUT_LINES = 60;
/** Diff lines kept per file, and files kept with their lines. */
const MAX_DIFF_LINES = 200;
const MAX_DIFF_FILES = 20;
/** What one turn's calls may take in the transcript, serialized. */
export const MAX_TURN_ACTIVITY_BYTES = 128 * 1024;

const KINDS = new Set(['tool-start', 'tool-done', 'tool-error']);

const clip = (text: string, limit = MAX_LINE_CHARS): string => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

/** A diff kept to `perFile` lines of at most `files` files; what is left out
 * is counted in `omitted`, so a preview counts exactly what it did before
 * and an undo knows the change is not whole. */
function boundDiff(files: readonly FileDiff[], perFile: number, withLines: number): FileDiff[] {
  return files.map((file, index) => {
    const keep = index < withLines ? perFile : 0;
    if (file.lines.length <= keep && file.lines.every((line) => line.text.length <= MAX_LINE_CHARS)) return file;
    const lines = file.lines.slice(0, keep).map((line) => ({ ...line, text: clip(line.text) }));
    return { ...file, lines, omitted: (file.omitted ?? 0) + file.lines.length - lines.length };
  });
}

/** One call's output kept to `limit` lines: its end when that is what the
 * row shows (a command, a stream's tail), else its start -- with the rest
 * counted the way the producer counts what it dropped. A command keeps its
 * first lines as `outputHead`, which is what its row shows above the tail. */
function boundOutput(event: HarnessActivityEvent, limit: number): HarnessActivityEvent {
  const output = event.output;
  if (!output) return event;
  const cleanHead = event.outputHead?.slice(0, COMMAND_HEAD_LINES).map((line) => clip(line));
  if (output.length <= limit && output.every((line) => line.length <= MAX_LINE_CHARS)) {
    return cleanHead && cleanHead.length !== event.outputHead!.length ? { ...event, outputHead: cleanHead } : event;
  }
  const fromEnd = event.outputTail === true || (event.category === 'run' && !event.outputOmitted);
  const kept = (fromEnd ? output.slice(-limit) : output.slice(0, limit)).map((line) => clip(line));
  const dropped = output.length - kept.length;
  return {
    ...event,
    output: kept,
    ...(dropped || event.outputOmitted ? { outputOmitted: (event.outputOmitted ?? 0) + dropped } : {}),
    ...(fromEnd && dropped ? {
      outputTail: true,
      outputHead: cleanHead ?? output.slice(0, COMMAND_HEAD_LINES).map((line) => clip(line)),
    } : cleanHead ? { outputHead: cleanHead } : {}),
  };
}

/** One call as it is kept: label, output and diff bounded. */
function boundEvent(event: HarnessActivityEvent): HarnessActivityEvent {
  const { diff: rawDiff, ...rest } = event;
  const diff = asFileDiffs(rawDiff);
  const bounded = boundOutput({ ...rest, label: clip(event.label, MAX_LABEL_CHARS) }, MAX_OUTPUT_LINES);
  return diff?.length ? { ...bounded, diff: boundDiff(diff, MAX_DIFF_LINES, MAX_DIFF_FILES) } : bounded;
}

/** A call trimmed to what its row shows, or (`bare`) to its row alone. */
function shrink(activity: TurnActivity, bare: boolean): TurnActivity {
  const { diff: rawDiff, output: _output, outputHead: _head, outputOmitted: _omitted, outputTail: _tail, ...rest } = activity.event;
  const diff = asFileDiffs(rawDiff);
  if (bare) {
    const lines = (activity.event.output?.length ?? 0) + (activity.event.outputOmitted ?? 0);
    const { call, ...withoutCall } = rest;
    return {
      ...activity,
      event: {
        ...withoutCall,
        ...(call ? { call: { name: call.name } } : {}),
        ...(lines ? { output: [], outputOmitted: lines } : {}),
        ...(diff?.length ? { diff: boundDiff(diff, 0, 0) } : {}),
      },
    };
  }
  const budget = Math.max(ACTIVITY_PREVIEW_LINES, COMMAND_HEAD_LINES + COMMAND_TAIL_LINES);
  const event = boundOutput(activity.event, budget);
  return { ...activity, event: diff?.length ? { ...event, diff: boundDiff(diff, DIFF_PREVIEW_LINES, DIFF_PREVIEW_FILES) } : event };
}

const sizes = new WeakMap<TurnActivity, number>();
function sizeOf(activity: TurnActivity): number {
  let size = sizes.get(activity);
  if (size === undefined) {
    size = JSON.stringify(activity).length;
    sizes.set(activity, size);
  }
  return size;
}

/** The list within MAX_TURN_ACTIVITY_BYTES: oldest calls trimmed to their
 * row's preview first, then to the row alone, and only then dropped. The
 * newest call is never trimmed by this: it is the one still on screen. */
export function boundTurnActivities(activities: TurnActivity[], limit = MAX_TURN_ACTIVITY_BYTES): TurnActivity[] {
  // Each record, plus the comma or bracket around it.
  let total = activities.reduce((sum, activity) => sum + sizeOf(activity) + 1, 1);
  if (total <= limit) return activities;
  const next = [...activities];
  for (const bare of [false, true]) {
    for (let index = 0; index < next.length - 1 && total > limit; index += 1) {
      const before = sizeOf(next[index]!);
      next[index] = shrink(next[index]!, bare);
      total += sizeOf(next[index]!) - before;
    }
  }
  while (total > limit && next.length > 1) total -= sizeOf(next.shift()!) + 1;
  return next;
}

/** One more frame of the turn, into its calls: a later frame of a call
 * (same id, or the open row with its label) merges into it and keeps where
 * it began; a sub-agent's calls remain in the journal for recovery while
 * counting toward its visible row; a thought is
 * never a row. Returns the same list when nothing changed. */
export function recordTurnActivity(
  activities: readonly TurnActivity[], event: HarnessActivityEvent, responseOffset: number,
): TurnActivity[] {
  if (event.kind === 'thinking') return activities as TurnActivity[];
  let current = activities as TurnActivity[];
  if (event.parentId && event.kind === 'tool-start') {
    const index = current.findIndex((activity) => activity.event.id === event.parentId && !activity.event.parentId);
    if (index >= 0) {
      current = [...current];
      current[index] = { ...current[index]!, event: withChildTool(current[index]!.event, event) };
    }
  }
  const bounded = boundEvent(event);
  for (let index = current.length - 1; index >= 0; index -= 1) {
    const prior = current[index]!;
    if (prior.event.parentId !== bounded.parentId || !sameCall(prior.event, bounded)) continue;
    const next = [...current];
    next[index] = { responseOffset: prior.responseOffset, event: boundEvent(mergeActivity(prior.event, bounded)) };
    return boundTurnActivities(next);
  }
  return boundTurnActivities([...current, { event: bounded, responseOffset: Math.max(0, responseOffset) }]);
}

/** Calls as stored, whatever wrote them: a list of records now, one-line
 * strings ("started Bash(…)", "completed Bash(…)") in journals written
 * before -- read as calls placed at `legacyOffset`, since where they
 * happened was never kept. Anything else is skipped, never thrown on. */
export function readTurnActivities(value: unknown, legacyOffset = 0): TurnActivity[] {
  if (!Array.isArray(value)) return [];
  let activities: TurnActivity[] = [];
  let legacy = false;
  for (const item of value) {
    if (typeof item === 'string') {
      const match = /^(started|completed|failed) ([\s\S]+)$/.exec(item.trim());
      if (!match) continue;
      legacy = true;
      const kind = match[1] === 'started' ? 'tool-start' : match[1] === 'failed' ? 'tool-error' : 'tool-done';
      // A completion some vendors report under a generic label ("tool")
      // closes the newest open call; its start carried the real name.
      if (match[2] === 'tool' && kind !== 'tool-start') {
        let open = activities.length - 1;
        while (open >= 0 && activities[open]!.event.kind !== 'tool-start') open -= 1;
        if (open >= 0) activities[open] = { ...activities[open]!, event: { ...activities[open]!.event, kind } };
        continue;
      }
      activities = recordTurnActivity(activities, { kind, label: match[2]! }, legacyOffset);
      continue;
    }
    const record = item as Partial<TurnActivity> | null;
    const event = record?.event as Partial<HarnessActivityEvent> | undefined;
    if (!event || typeof event !== 'object' || typeof event.label !== 'string' || !KINDS.has(String(event.kind))) continue;
    const offset = record!.responseOffset;
    // Kept as the same object when it is already well-formed: the size
    // bound remembers each record's size by identity.
    activities.push(typeof offset === 'number' && Number.isFinite(offset) && offset >= 0
      ? record as TurnActivity
      : { event: event as HarnessActivityEvent, responseOffset: legacyOffset });
  }
  if (!legacy && activities.length === value.length && activities.every((activity, index) => activity === value[index])) return value as TurnActivity[];
  return activities;
}

/** The newest call still open, if the newest call is: what a window joining
 * the turn says it is running. */
export function runningTurnActivity(activities: readonly TurnActivity[]): HarnessActivityEvent | undefined {
  let last: HarnessActivityEvent | undefined;
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    if (!activities[index]!.event.parentId) { last = activities[index]!.event; break; }
  }
  return last?.kind === 'tool-start' ? last : undefined;
}

/** One message's share of a turn whose text a steer split into several:
 * the calls after `start` up to and including `end` (to the end when `end`
 * is undefined; from `start` itself for the first message), re-anchored to
 * `start`. A call at a steer's own offset goes before the steer, the order
 * every live view draws them in. */
export function activitiesBetween(
  activities: readonly TurnActivity[], start: number, end: number | undefined, length: number, first: boolean,
): TurnActivity[] {
  return activities
    .filter((activity) => (first ? activity.responseOffset >= start : activity.responseOffset > start)
      && (end === undefined || activity.responseOffset <= end))
    .map((activity) => ({ ...activity, responseOffset: Math.min(length, Math.max(0, activity.responseOffset - start)) }));
}

/** Bytes of a text summary of calls. */
const SUMMARY_MAX_CHARS = 1500;

/** What a text-only reader is told of a turn that wrote no text: the calls
 * it made, newest kept. */
export function activityTextSummary(activities: readonly TurnActivity[]): string {
  const rows = activities.map(({ event }) => `${event.label}${event.kind === 'tool-error' ? ' (failed)' : event.kind === 'tool-start' ? ' (not finished)' : ''}`);
  const kept: string[] = [];
  let room = SUMMARY_MAX_CHARS;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.length + 2 > room) break;
    kept.unshift(row);
    room -= row.length + 2;
  }
  const earlier = rows.length - kept.length;
  return `Tool calls: ${earlier ? `(${earlier} earlier) ` : ''}${kept.join('; ')}.`;
}

/** The conversation as text, for a reader that takes nothing else: a model's
 * history, a replay into another provider, an export. A message's calls are
 * not sent; a turn that only called tools is told as a short summary of
 * them, and a message with nothing at all is left out. */
export function textTranscript(messages: readonly TranscriptMessage[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  return messages.flatMap((message) => {
    if (message.role !== 'assistant' || message.content.trim()) return [{ role: message.role, content: message.content }];
    const activities = readTurnActivities(message.activities);
    return activities.length ? [{ role: 'assistant' as const, content: activityTextSummary(activities) }] : [];
  });
}
