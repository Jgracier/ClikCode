/** How a turn reads while it unfolds: the words a tool row and the status
 * line use, what a finished call found, how a run of looking-around calls
 * merges, and the line a turn ends on. One set of rules for the terminal and
 * the VS Code webview (no styling here, so the webview can bundle it), taken
 * from what Claude Code, Codex, Cursor and Grok Build agree on. */

import type { FileDiff } from '../../agent/line-diff.js';
import type { HarnessActivityEvent } from '../prompter.js';
import { compactCount, formatElapsed } from './format.js';
import type { TurnUsage } from './turn-usage.js';
import { SHIMMER_WIDTH } from './timings.js';

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

/** Calls that only look around -- reads, searches and directory listings (a
 * listing is category `search`; tools.ts) -- are one row while a
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

/** The reasoning under the status line: without the heading the status
 * line already shows, and without its markdown emphasis. */
export function reasoningBody(thought: string): string {
  // A heading still arriving (`**Inspecting the`) is not body text yet.
  return thought.replace(/\*\*([^*\n]{3,80})\*\*/, '').replace(/^\s*\*\*[^*\n]*$/, '').replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim();
}

/** Whether the status line says "writing": answer text has arrived in THIS
 * response and no call has started since. It holds through any pause -- a
 * slow model, an ACP stall -- until a call starts or the turn ends, so
 * half-printed text is never labelled "thinking" (standard section 9).
 * `callAt` is when the latest call started: a call after the text begins a
 * new response, which is "thinking" again until text arrives. Timestamps
 * from any monotonic counter work; the terminal and the webview each keep
 * `writingAt` (last text) and `callAt` (last call start). */
export function answerWriting(state: { writingAt?: number; callAt?: number }): boolean {
  return state.writingAt !== undefined && (state.callAt === undefined || state.writingAt > state.callAt);
}

/** What the user decided at an approval or a question. */
export type Decision =
  | { kind: 'approved'; label: string; always?: boolean }
  | { kind: 'denied'; label: string }
  /** Denied with "tell it instead": the words that were sent. */
  | { kind: 'told'; text: string }
  | { kind: 'answered'; label: string; values?: readonly string[] }
  | { kind: 'declined'; label: string };

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** A settled thought's row, in words and without its glyph (the terminal
 * puts `✻` in front, the webview its own icon): how long it went on, and the
 * model's own heading when it wrote one -- `Thought for 3s · Reading the
 * parser` (standard section 4). */
export function thoughtRow(thought: { durationMs: number; heading?: string }): string {
  const heading = thought.heading?.replace(/\s+/g, ' ').trim();
  return `Thought for ${formatElapsed(Math.max(1000, thought.durationMs))}${heading ? ` · ${heading}` : ''}`;
}

/** The settled row a decision leaves at its place in the turn: `✓ approved
 * make clean`, `✗ denied make clean`, `↳ told: use pnpm instead`, `✓
 * answered Which database?: MySQL` (standard section 8). `tone` is what the
 * surface colours it by. Values of a question are only passed where they
 * are safe to show (never a secret). */
export function decisionRow(decision: Decision): { text: string; tone: 'ok' | 'no' | 'told' } {
  switch (decision.kind) {
    case 'approved': return { text: `✓ approved${decision.always ? ' (always)' : ''} ${oneLine(decision.label, 80)}`, tone: 'ok' };
    case 'denied': return { text: `✗ denied ${oneLine(decision.label, 80)}`, tone: 'no' };
    case 'told': return { text: `↳ told: ${oneLine(decision.text, 120)}`, tone: 'told' };
    case 'answered': {
      const values = decision.values?.length ? `: ${oneLine(decision.values.join(', '), 80)}` : '';
      return { text: `✓ answered ${oneLine(decision.label, 60)}${values}`, tone: 'ok' };
    }
    case 'declined': return { text: `✗ declined ${oneLine(decision.label, 80)}`, tone: 'no' };
  }
}

/** The adapters' own phase while an approval is up ("waiting for your
 * approval: make clean"): true for it, so a surface does not restore it as
 * the status once the approval is answered -- by then it is stale. */
export function isApprovalWaitPhase(phase: string | undefined): boolean {
  return Boolean(phase && /^waiting for (?:your |the )?(?:approval|answer|permission|input)\b/i.test(phase.trim()));
}

export type StatusTone = 'thinking' | 'tool' | 'asking';

/** What the status line says and how it looks: waiting on the user, else the
 * open call's verb, else the reasoning's own heading, else "writing" while
 * answer text arrives, else "thinking". A quiet clock does not invent a
 * longer phrase. */
export function turnStatus(state: {
  phase?: string; toolPhase?: string; thought?: string; asking?: boolean; writing?: boolean;
}): { label: string; tone: StatusTone } {
  if (state.asking) return { label: 'waiting for you', tone: 'asking' };
  if (state.toolPhase) return { label: state.toolPhase, tone: 'tool' };
  const heading = reasoningHeading(state.thought);
  const phase = state.phase?.replace(/(…|\.\.\.)$/, '').trim();
  const thinking = !phase || /^thinking$/i.test(phase);
  const label = heading ?? (!thinking ? phase! : state.writing ? 'writing' : 'thinking');
  return { label, tone: 'thinking' };
}

/** Tokens in `chars` characters of response, as a model counts them. */
export function estimateTokens(chars: number): number {
  return Math.max(0, Math.round(chars / 4));
}

/** How many tokens the turn has produced so far: the larger of what the
 * vendor's usage for the turn says (output tokens, where it reports them)
 * and the length of what was written (answer and reasoning) / 4. A vendor's
 * reading is often taken once, early in a message, and then not again until
 * the turn ends; used alone it left the meter on one number however much
 * more was written -- and a window that joined the turn later showed that
 * number from the start. Both are lower bounds on the truth, so the larger
 * is the better one. The shown count steps toward this (smoothTokens). */
export function liveTokenTarget(state: { usage?: Pick<TurnUsage, 'output'>; responseChars: number; thoughtChars?: number }): number {
  const reported = state.usage?.output;
  const counted = reported !== undefined && reported > 0 ? Math.round(reported) : 0;
  return Math.max(counted, estimateTokens(state.responseChars + (state.thoughtChars ?? 0)));
}

/** One step of the shown count toward its target: a fifth of the gap, at
 * least one, never past the target and never down within a turn -- a
 * vendor's later, lower reading or a replaced snapshot does not make the
 * number fall. */
export function smoothTokens(shown: number, target: number): number {
  if (target <= shown) return shown;
  return Math.min(target, shown + Math.max(1, Math.ceil((target - shown) / 5)));
}

/** The meter the status line carries, as Claude Code words it:
 * `↓ 1.2k tokens`. Nothing while the count is zero: an unknown count is not
 * "0 tokens" (so the 16 s Claude Code waits to show a meter is moot here --
 * it shows as soon as there is anything to count). */
export function tokenMeterLabel(tokens: number): string | undefined {
  return tokens > 0 ? `↓ ${compactCount(tokens)} tokens` : undefined;
}

/** One frame of the shimmer the status label wears (Claude Code and Codex
 * both sweep a highlight across it): each character's brightness, 0..1, as
 * a band `width` characters wide passes over. */
export function shimmerLevels(length: number, frame: number, width = SHIMMER_WIDTH): number[] {
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
 * "3 files edited": how long, and what it changed -- then what it spent
 * (`usage`, already worded by formatTurnUsage's brief form, so the terminal
 * and the extension say the same). A turn that left background agents
 * running says `Waiting for 2 background agents` where it would say
 * "Worked for" (standard section 10), and `and 1 dynamic workflow` after
 * them as Claude Code words it (`pendingWorkflows`); either absent or 0 is
 * none. Background terminals are never part of this line: see
 * backgroundTerminalsLabel. */
export function turnSummary(state: {
  ms: number; diffs?: ReadonlyArray<readonly FileDiff[]>; stopped?: boolean; usage?: string; pendingBackground?: number;
  pendingWorkflows?: number;
}): string {
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
  const spent = state.usage ? ` · ${state.usage}` : '';
  const count = (value: number | undefined): number => (value && value > 0 ? Math.floor(value) : 0);
  const agents = count(state.pendingBackground);
  const workflows = count(state.pendingWorkflows);
  // Claude Code's own words (its turn-duration row): agents, then `and`,
  // then dynamic workflows.
  if (agents || workflows) {
    const waiting = [...(agents ? [plural(agents, 'background agent')] : []), ...(workflows ? [plural(workflows, 'dynamic workflow')] : [])].join(' and ');
    return `Waiting for ${waiting}${changed}${spent}`;
  }
  // A stopped turn says so where it ends: "Stopped" is otherwise only a
  // passing notice, and "Worked for" read as a turn that finished.
  return `${state.stopped ? 'Stopped after' : 'Worked for'} ${formatElapsed(Math.max(1000, state.ms))}${changed}${spent}`;
}

/** The footer indicator for background terminals (standard section 10), as
 * Codex words it: `1 background terminal running` / `3 background terminals
 * running`. Nothing at zero or unknown. It is a footer row, never a part of
 * the turn's end line. */
export function backgroundTerminalsLabel(count: number | undefined): string | undefined {
  const terminals = count && count > 0 ? Math.floor(count) : 0;
  return terminals ? `${plural(terminals, 'background terminal')} running` : undefined;
}
