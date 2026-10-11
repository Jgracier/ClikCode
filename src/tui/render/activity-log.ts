/** The activity log: one entry per tool call or assistant turn, upserted as
 * events arrive and rebased when the transcript above it grows. */

import { asFileDiffs } from '../../agent/line-diff.js';
import chalk from 'chalk';
import { sanitizeTerminalText } from './text.js';
import { visibleSlice } from './width.js';
import { renderActivityLine } from '../../harness/protocol/activity-line.js';
import { mergeActivity, sameCall, stoppedCall } from '../../harness/protocol/activity-view.js';
import type { HarnessActivityEvent } from '../../harness/prompter.js';
import { TOOL_CATEGORY_STYLE } from '../../harness/protocol/tool-category-style.js';
import { decisionRow, type Decision } from '../../harness/protocol/turn-flow.js';

/** One rendered activity row and where it belongs: the message index it was
 * reported under, and -- for a row produced inside a turn -- the response
 * offset it started at, which is where it is written back into the prose.
 * `startedAt` is when the call was first seen, for its running timer. */
export type ActivityEntry = {
  anchor: number; responseOffset?: number; sequence?: number; startedAt?: number;
  /** Absent for a note: a row that is only its `lines` (activity()). */
  event?: HarnessActivityEvent; lines: string[];
  /** What the user decided about this call (standard section 8). It is the
   * call's row that says so, not a second row: a refusal replaces the call's
   * own failure line, an approval is said once on the call that then runs. */
  decision?: EntryDecision;
  /** A decision row that stands alone because nothing had been reported for
   * the call it was about. A later frame of that call is absorbed into it. */
  decisionFor?: string;
};

/** A decision, worded and styled once. */
export type EntryDecision = {
  kind: Decision['kind'];
  /** The whole settled row: `✗ denied rm -rf build`. */
  row: string;
  /** What an approved call's own first line carries instead. */
  suffix: string;
};

const paintDecision = (text: string, tone: 'ok' | 'no' | 'told'): string => {
  const glyph = tone === 'ok' ? chalk.green : tone === 'no' ? chalk.red : chalk.cyan;
  return sanitizeTerminalText(glyph(text.slice(0, 1)) + chalk.dim(text.slice(1)), { keepSgr: true, singleLine: true });
};

/** A call's rows, with the user's decision on it where there was one. */
export function entryLines(event: HarnessActivityEvent, decision?: EntryDecision): string[] {
  const lines = renderActivityLine(event).map((line) => line.trim());
  if (!decision) return lines;
  if (decision.kind !== 'approved') return [decision.row];
  return lines.length ? [`${lines[0]}${decision.suffix}`, ...lines.slice(1)] : [decision.row];
}

/** Settle a decision where it belongs: on the row of the call it was about
 * when there is one (kept where the call began), else as a row of its own at
 * the answer's current place. One event is one row. */
export function settleDecisionEntry(entries: readonly ActivityEntry[], at: {
  anchor: number; responseOffset?: number; sequence: number; callId?: string; decision: Decision;
}): ActivityEntry[] {
  const { text, tone } = decisionRow(at.decision);
  const decision: EntryDecision = {
    kind: at.decision.kind, row: paintDecision(text, tone),
    suffix: chalk.dim(` · approved${at.decision.kind === 'approved' && at.decision.always ? ' (always)' : ''}`),
  };
  const next = [...entries];
  const index = at.callId === undefined ? -1 : next.findIndex((entry) => entry.anchor === at.anchor && entry.event?.id === at.callId);
  if (index >= 0) {
    const prior = next[index]!;
    next[index] = { ...prior, decision, lines: entryLines(prior.event!, decision) };
    return next;
  }
  next.push({
    anchor: at.anchor, ...(at.responseOffset === undefined ? {} : { responseOffset: at.responseOffset }), sequence: at.sequence,
    lines: [decision.row], decision, ...(at.callId === undefined ? {} : { decisionFor: at.callId }),
  });
  return next;
}

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
  // A diff from an older build or an older saved turn is read in its own
  // shape (asFileDiffs), never assumed to be the current one.
  const { diff: rawDiff, ...rest } = event;
  const files = asFileDiffs(rawDiff);
  const normalized: HarnessActivityEvent = {
    ...rest,
    label: visibleSlice(sanitizeTerminalText(event.label, { singleLine: true }).replace(/\s+/g, ' ').trim() || 'tool', 120),
    ...(event.output ? { output: cleanLines(event.output) } : {}),
    ...(event.outputHead ? { outputHead: cleanLines(event.outputHead) } : {}),
    ...(files?.length ? { diff: files.map((file) => ({ ...file, lines: file.lines.map((line) => ({ ...line, text: cleanLines([line.text])[0]! })) })) } : {}),
  };
  const matchIndex = (() => {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      if (entry.anchor !== anchor || !entry.event) continue;
      if (sameCall(entry.event, normalized)) return index;
    }
    return -1;
  })();
  const next = [...entries];
  if (matchIndex >= 0) {
    const prior = next[matchIndex]!;
    const effective = mergeActivity(prior.event!, normalized);
    next[matchIndex] = { ...prior, event: effective, lines: entryLines(effective, prior.decision) };
  } else {
    // A refusal made before the call was reported stands alone, and the
    // call's failure frame that follows is the same event: absorbed, since
    // the standalone row is most likely already in scrollback. An approval
    // that stood alone is said already; the call that then runs is its own row.
    const early = normalized.id === undefined ? undefined
      : next.find((entry) => entry.anchor === anchor && entry.decisionFor === normalized.id);
    if (early?.decision && early.decision.kind !== 'approved') return next;
    next.push({
      anchor, ...(responseOffset === undefined ? {} : { responseOffset }), ...(sequence === undefined ? {} : { sequence }),
      startedAt: now, event: normalized, lines: entryLines(normalized),
    });
  }
  // Do not evict old entries here. Some may already be immutable native
  // scrollback; removing one would invalidate the rendered prefix and force a
  // full-screen reset. No entry is ever collapsed into a count either: a row
  // whose text can still change could never enter scrollback at all.
  return next;
}

/** Calls closed as stopped (stoppedCall) where `stops` says their turn was
 * stopped under them: the entries that are still open, re-rendered. The
 * same list when none was. */
export function stopEntries(entries: readonly ActivityEntry[], stops: (entry: ActivityEntry) => boolean): ActivityEntry[] {
  let changed = false;
  const next = entries.map((entry) => {
    if (entry.event?.kind !== 'tool-start' || !stops(entry)) return entry;
    changed = true;
    const event = stoppedCall(entry.event);
    return { ...entry, event, lines: entryLines(event, entry.decision) };
  });
  return changed ? next : entries as ActivityEntry[];
}

/** A replacement stream is usually a cumulative snapshot. Offsets within its
 * unchanged prefix remain valid; offsets in rewritten text do not, so attach
 * those events at the divergence boundary instead of leaving them beyond or
 * inside unrelated prose. */
export function commonPrefixLength(previous: string, replacement: string): number {
  let commonPrefix = 0;
  const shared = Math.min(previous.length, replacement.length);
  while (commonPrefix < shared && previous[commonPrefix] === replacement[commonPrefix]) commonPrefix += 1;
  return commonPrefix;
}

export function rebaseActivityOffsets(
  entries: readonly ActivityEntry[], anchor: number, previous: string, replacement: string,
): ActivityEntry[] {
  const commonPrefix = commonPrefixLength(previous, replacement);
  return entries.map((entry) => entry.anchor === anchor && entry.responseOffset !== undefined
    && entry.responseOffset > commonPrefix
    ? { ...entry, responseOffset: commonPrefix }
    : entry);
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
