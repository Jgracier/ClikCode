/** The activity log: one entry per tool call or assistant turn, upserted as
 * events arrive and rebased when the transcript above it grows. */

import chalk from 'chalk';
import { stdout as output } from 'node:process';
import { sanitizeTerminalText } from './text.js';
import { visibleSlice } from './width.js';
import { renderActivityLine } from '../../harness/protocol/activity-line.js';
import type { HarnessActivityEvent, ToolCategory } from '../../harness/prompter.js';

/** Keep the persisted history window stable while transient assistant and
 * queued rows are appended. Applying the history cap to the combined array
 * drops its first persisted row, breaks the native-scrollback prefix, and
 * causes every live frame to be rejected until the final commit. */
/** One rendered activity row and where it belongs: the message index it was
 * reported under, and -- for a row produced inside a turn -- the response
 * offset it started at, which is where it is written back into the prose. */
export type ActivityEntry =
  { anchor: number; responseOffset?: number; sequence?: number; event?: HarnessActivityEvent; lines: string[] };

/** One provider may publish pending/running/progress frames for the same tool.
 * They describe one lifecycle, not separate calls. Upsert by native id, or by
 * the latest still-open matching label when a protocol omits ids. */
export function upsertActivityEvent(
  entries: readonly ActivityEntry[], anchor: number, responseOffset: number | undefined, event: HarnessActivityEvent, sequence?: number,
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
      if (entry.anchor !== anchor || entry.event?.kind !== 'tool-start') continue;
      if (normalized.id ? entry.event.id === normalized.id
        : entry.event.label === normalized.label) return index;
    }
    return -1;
  })();
  const next = [...entries];
  if (matchIndex >= 0) {
    const prior = next[matchIndex]!;
    const effective = {
      ...normalized,
      ...(normalized.label === 'tool' ? { label: prior.event!.label } : {}),
      // A completion frame routinely carries neither the name nor the input
      // the category was derived from. The row keeps what its start knew.
      ...(normalized.category ? {} : prior.event?.category ? { category: prior.event.category } : {}),
      ...(normalized.diff ? {} : prior.event?.diff ? { diff: prior.event.diff } : {}),
    };
    next[matchIndex] = { ...prior, event: effective, lines: renderActivityLine(effective).map((line) => line.trim()) };
  } else {
    next.push({
      anchor, ...(responseOffset === undefined ? {} : { responseOffset }), ...(sequence === undefined ? {} : { sequence }),
      event: normalized, lines: renderActivityLine(normalized).map((line) => line.trim()),
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

/** Derive the spinner from the whole in-flight tool set rather than the most
 * recent provider event. A reasoning summary or one parallel completion must
 * not claim the agent is merely thinking while another tool is still live. */
/** One place decides how a category looks and reads, for the retired row, the
 * running row and the spinner alike. The glyph stays the same for every
 * category on purpose: the shape is the transcript's, the colour is the
 * tool's. Nothing is spelled out in front of a label -- the label already
 * says `Read(...)` or `Bash(...)`, so colour is an aid here, not the only
 * carrier, and a NO_COLOR terminal loses nothing it needs. */
/** How each kind of work reads: its colour, the verb used while it runs, and
 * the glyph that marks its settled row.
 *
 * The glyphs are all single-width and drawn from the same geometric block, so
 * a column of them lines up and none of them is an emoji -- a terminal that
 * renders one at double width breaks every row beneath it, and a phone is
 * exactly where that happens. Colour alone carried the type before, which is
 * nothing at all on a NO_COLOR or piped transcript. */
export const TOOL_CATEGORY_STYLE: Record<ToolCategory, {
  paint: (text: string) => string; verb: string; glyph: string;
  /** How a folded run of these reads once it has settled. */
  folded: (count: number) => string;
}> = {
  read: { paint: (text) => chalk.blue(text), verb: 'reading', glyph: '◇', folded: (n) => `read ${n} files` },
  edit: { paint: (text) => chalk.magenta(text), verb: 'editing', glyph: '◆', folded: (n) => `edited ${n} files` },
  run: { paint: (text) => chalk.yellow(text), verb: 'running', glyph: '▸', folded: (n) => `ran ${n} commands` },
  search: { paint: (text) => chalk.cyan(text), verb: 'searching', glyph: '◈', folded: (n) => `searched ${n} times` },
  fetch: { paint: (text) => chalk.green(text), verb: 'fetching', glyph: '↓', folded: (n) => `fetched ${n} pages` },
};

/** The marker a settled tool row opens with. An uncategorised tool keeps the
 * neutral dot the transcript already used, so nothing regresses to a blank. */
export function toolGlyph(category?: ToolCategory): string {
  return category ? TOOL_CATEGORY_STYLE[category].glyph : '·';
}

export function activityLifecyclePhase(
  activeTools: ReadonlyMap<string, { label: string; category?: ToolCategory }>, event: HarnessActivityEvent,
): { activeTools: Map<string, { label: string; category?: ToolCategory }>; phase: string; category?: ToolCategory } {
  const next = new Map(activeTools);
  const key = event.id ?? event.label;
  if (event.kind === 'tool-start') next.set(key, { label: event.label, ...(event.category ? { category: event.category } : {}) });
  else if (event.kind === 'tool-done' || event.kind === 'tool-error') {
    if (!next.delete(key) && !event.id) {
      const matchingKey = [...next].reverse().find(([, tool]) => tool.label === event.label)?.[0];
      if (matchingKey) next.delete(matchingKey);
    }
  }
  const running = [...next.values()];
  const current = running[running.length - 1];
  if (!current) return { activeTools: next, phase: 'thinking' };
  // The verb is what the tool is doing, not a generic "running" for
  // everything. An unclassified tool keeps the word it always had.
  const verb = current.category ? TOOL_CATEGORY_STYLE[current.category].verb : 'running';
  return {
    activeTools: next, phase: `${verb} ${current.label}`,
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
  if (liveResponse && !waiting && settledAssistant !== undefined) {
    const live = liveResponse.trim();
    const settled = settledAssistant.trim();
    if (live && (settled === live || settled.endsWith(live))) return false;
  }
  return Boolean(liveResponse || (waiting && entries.some((entry) =>
    entry.anchor === transcriptLength && entry.responseOffset !== undefined)));
}
