/** How a turn reads while it unfolds: the words a tool row and the status
 * line use, what a finished call found, how a run of looking-around calls
 * merges, and the line a turn ends on. One set of rules for the terminal and
 * the VS Code webview (no styling here, so the webview can bundle it), taken
 * from what Claude Code, Codex, Cursor and Grok Build agree on. */

import type { FileDiff } from '../../agent/line-diff.js';
import type { HarnessActivityEvent } from '../prompter.js';
import { formatElapsed } from './activity-view.js';

/** Each row's first word, running and done ("Reading" / "Read"), as all four
 * write it. A command keeps its `$`; an unknown tool keeps its own name. */
const TENSES: Record<string, [running: string, done: string]> = {
  Read: ['Reading', 'Read'],
  Edit: ['Editing', 'Edited'],
  Write: ['Writing', 'Wrote'],
  Grep: ['Searching', 'Searched'],
  Search: ['Searching', 'Searched'],
  Glob: ['Finding', 'Found'],
  List: ['Listing', 'Listed'],
  Fetch: ['Fetching', 'Fetched'],
  'Web search': ['Searching the web', 'Searched the web'],
};

/** A row's label in the tense of its state: `Reading src/a.ts` while it
 * runs, `Read src/a.ts` once done. An MCP call (`server › tool`) is
 * `Calling` / `Called`. */
export function tensedLabel(label: string, running: boolean): string {
  if (label.startsWith('$ ') || label === '$') return label;
  for (const [verb, [ing, ed]] of Object.entries(TENSES)) {
    if (label === verb || label.startsWith(`${verb} `)) return `${running ? ing : ed}${label.slice(verb.length)}`;
  }
  if (label.includes(' › ')) return `${running ? 'Calling' : 'Called'} ${label}`;
  return label;
}

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/** What a finished call found, in a few words: `42 lines` read, `3 matches`,
 * `5 files`. Only from output the harness actually reported; nothing when
 * it reported none (an empty result and an unreported one look alike). */
export function activityResult(event: Pick<HarnessActivityEvent, 'kind' | 'label' | 'category' | 'output' | 'outputOmitted'>): string | undefined {
  if (event.kind !== 'tool-done') return undefined;
  const lines = (event.output?.filter((line) => line.trim()).length ?? 0) + (event.outputOmitted ?? 0);
  if (!lines) return undefined;
  if (event.category === 'read') return plural(lines, 'line');
  if (event.category !== 'search') return undefined;
  if (/^(Glob|List)\b/.test(event.label)) return plural(lines, /^List\b/.test(event.label) ? 'entry' : 'file', /^List\b/.test(event.label) ? 'entries' : 'files');
  return plural(lines, 'match', 'matches');
}

/** Calls that only look around -- reads and searches -- are one row while a
 * run of them goes on, as Codex's "Explored" and Cursor's merged reads are. */
export function explores(event: Pick<HarnessActivityEvent, 'category' | 'agent' | 'kind'>): boolean {
  return !event.agent && event.kind !== 'tool-error' && (event.category === 'read' || event.category === 'search');
}

/** A run of looking-around calls in one line, as Claude Code says it:
 * `Read 3 files, searched 2 patterns, listed 1 directory`; in the present
 * tense while any of them still runs. */
export function exploreSummary(events: ReadonlyArray<Pick<HarnessActivityEvent, 'kind' | 'label' | 'category'>>): string {
  const running = events.some((event) => event.kind === 'tool-start');
  let reads = 0;
  let searches = 0;
  let lists = 0;
  for (const event of events) {
    if (event.category === 'read') reads += 1;
    else if (/^List\b/.test(event.label)) lists += 1;
    else searches += 1;
  }
  const parts = [
    ...(reads ? [`${running ? 'reading' : 'read'} ${plural(reads, 'file')}`] : []),
    ...(searches ? [`${running ? 'searching' : 'searched'} ${plural(searches, 'pattern')}`] : []),
    ...(lists ? [`${running ? 'listing' : 'listed'} ${plural(lists, 'directory', 'directories')}`] : []),
  ].join(', ');
  return parts.charAt(0).toUpperCase() + parts.slice(1);
}

/** Groups a turn's rows for display: runs of two or more looking-around
 * calls in a row become one group, everything else stands alone. */
export function exploreRuns<T extends Pick<HarnessActivityEvent, 'category' | 'agent' | 'kind'>>(rows: readonly T[]): Array<{ rows: T[]; explore: boolean }> {
  const groups: Array<{ rows: T[]; explore: boolean }> = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (explores(row) && last?.explore) { last.rows.push(row); continue; }
    if (explores(row) && last && !last.explore && last.rows.length === 1 && explores(last.rows[0]!)) { last.rows.push(row); last.explore = true; continue; }
    groups.push({ rows: [row], explore: false });
  }
  return groups;
}

/** The heading a model puts on its reasoning (Codex shows it as the status:
 * "**Inspecting the parser**"), or nothing. */
export function reasoningHeading(thought: string | undefined): string | undefined {
  const heading = thought ? /\*\*([^*\n]{3,80})\*\*/.exec(thought)?.[1]?.trim() : undefined;
  return heading || undefined;
}

/** Claude Code's way of saying a long think is still a think. */
const THINKING_WORDS: Array<[afterMs: number, words: string]> = [
  [45_000, 'deep in thought'], [30_000, 'thinking some more'], [20_000, 'thinking more'], [10_000, 'still thinking'], [0, 'thinking'],
];

export type StatusTone = 'thinking' | 'tool' | 'asking' | 'stalled';

/** Quiet this long starts the spinner toward red; it is fully red ten
 * seconds later (Claude Code's ramp). */
export const STALL_FADE_MS = 10_000;

/** What the status line says and how it looks: waiting on the user, else the
 * open call's verb, else the reasoning's own heading, else how long the
 * thinking has gone on in words; its tone, and how far toward red silence
 * has taken it (0..1). */
export function turnStatus(state: {
  phase?: string; toolPhase?: string; thought?: string; thinkingMs?: number; asking?: boolean; quietMs?: number;
}): { label: string; tone: StatusTone; stall: number } {
  const stall = state.asking || state.toolPhase ? 0 : Math.min(1, Math.max(0, ((state.quietMs ?? 0) - STALL_FADE_MS) / STALL_FADE_MS));
  if (state.asking) return { label: 'waiting for you', tone: 'asking', stall: 0 };
  if (state.toolPhase) return { label: state.toolPhase, tone: 'tool', stall };
  const heading = reasoningHeading(state.thought);
  const phase = state.phase?.replace(/(…|\.\.\.)$/, '').trim();
  const thinking = !phase || /^thinking$/i.test(phase);
  // A clock read a moment before the thinking began gives a negative time
  // (or none at all): that is still just "thinking", never no words.
  const thinkingMs = Number.isFinite(state.thinkingMs) ? Math.max(0, state.thinkingMs!) : 0;
  const label = heading ?? (thinking ? THINKING_WORDS.find(([after]) => thinkingMs >= after)![1] : phase!);
  return { label, tone: stall >= 1 ? 'stalled' : 'thinking', stall };
}

/** One frame of the shimmer the status label wears (Claude Code and Codex
 * both sweep a highlight across it): each character's brightness, 0..1, as
 * a band `width` characters wide passes over. */
export function shimmerLevels(length: number, frame: number, width = 4): number[] {
  const span = length + width * 2;
  const centre = (frame % span) - width;
  return Array.from({ length }, (_, index) => {
    const distance = Math.abs(index - centre) / width;
    return distance >= 1 ? 0 : (Math.cos(distance * Math.PI) + 1) / 2;
  });
}

/** Pastes this long are held as a placeholder rather than dumped into the
 * message box (`[Pasted text #1 +40 lines]`); the text still goes with the
 * message. */
export function pastePlaceholder(text: string, index: number): string | undefined {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n').length;
  if (lines <= 3 && text.length <= 800) return undefined;
  return `[Pasted text #${index}${lines > 1 ? ` +${lines} lines` : ''}]`;
}

/** A turn this long ends on its summary line even if it ran no tools. */
export const END_SUMMARY_MS = 10_000;

/** Whether a turn ends on the summary line: it did real work -- ran a tool,
 * or took a while. A quick answer needs no "Worked for 2s" under it. */
export function endsWithSummary(ms: number, calls: number): boolean {
  return calls > 0 || ms >= END_SUMMARY_MS;
}

/** The line a turn ends on, as Codex's "Worked for 1m 2s" and Cursor's
 * "3 files edited": how long, and what it changed. */
export function turnSummary(state: { ms: number; diffs?: ReadonlyArray<readonly FileDiff[]> }): string {
  const files = new Map<string, { additions: number; removals: number }>();
  for (const diff of state.diffs ?? []) {
    for (const file of diff) {
      const key = file.path ?? `#${files.size}`;
      const prior = files.get(key) ?? { additions: 0, removals: 0 };
      files.set(key, { additions: prior.additions + file.additions, removals: prior.removals + file.removals });
    }
  }
  const additions = [...files.values()].reduce((sum, file) => sum + file.additions, 0);
  const removals = [...files.values()].reduce((sum, file) => sum + file.removals, 0);
  const changed = files.size ? ` · ${plural(files.size, 'file')} changed${additions ? ` +${additions}` : ''}${removals ? ` −${removals}` : ''}` : '';
  return `Worked for ${formatElapsed(Math.max(1000, state.ms))}${changed}`;
}
