/** Where a turn's time goes, measured by the product itself, forever.
 *
 * A turn writes ONE lifecycle line per moment on its path (`turn.mark`), each
 * carrying the turn's shared `turnId`, the moment's name, and `ms` since the
 * window's `submit`. Marks are at turn boundaries only: the log append is a
 * synchronous fs write, so nothing here is ever called once per delta -- after
 * a mark has been written, asking for it again is one Set lookup and no I/O.
 *
 * The window and the worker are different processes on one machine, so a
 * wall-clock `submittedAt` travels with the turn and both measure from it.
 *
 * `turnLatency` turns the lines of one turn into the breakdown. It is pure and
 * chalk-free; `clikcode logs --latency` prints it. */
import { lifecycle } from './lifecycle-log.js';

/** The moments, in the order they happen on the path. */
const TURN_MARKS = [
  'submit', 'accepted', 'account', 'spawned', 'ready', 'prompt-sent',
  'first-byte', 'first-event', 'first-text', 'first-paint', 'first-text-paint', 'end',
] as const;
export type TurnMarkName = (typeof TURN_MARKS)[number];

interface TurnClock {
  readonly turnId: string;
  readonly startedAt: number;
  harness?: string;
  readonly seen: Set<TurnMarkName>;
}

let current: TurnClock | undefined;

/** Starts measuring a turn in this process: `startedAt` is the submit's
 * wall-clock time (the window's, handed over with the turn). */
export function beginTurnClock(turn: { turnId: string; startedAt?: number; harness?: string }): void {
  current = { turnId: turn.turnId, startedAt: turn.startedAt ?? Date.now(), ...(turn.harness ? { harness: turn.harness } : {}), seen: new Set() };
}

/** Stops measuring (only the turn that began it: a later turn's clock stays). */
export function endTurnClock(turnId?: string): void {
  if (turnId === undefined || current?.turnId === turnId) current = undefined;
}

export function currentTurnId(): string | undefined {
  return current?.turnId;
}

/** The vendor command, once it is known (the window knows it at submit; a
 * worker's transport at spawn). */
export function setTurnHarness(harness: string | undefined): void {
  if (current && harness && !current.harness) current.harness = harness;
}

/** Whether `mark` is still to be written for this turn: the cheap check a hot
 * path makes before building anything for a mark. */
export function turnMarkOpen(mark: TurnMarkName): boolean {
  return Boolean(current) && !current!.seen.has(mark);
}

/** Records `mark` once for the running turn. A no-op with no turn being
 * measured, for a mark already written, and (first-byte) before the prompt
 * went out -- a handshake answer is not the vendor's answer. */
export function markTurn(mark: TurnMarkName, fields: Readonly<Record<string, unknown>> = {}): void {
  const clock = current;
  if (!clock || clock.seen.has(mark)) return;
  if (mark === 'first-byte' && !clock.seen.has('prompt-sent')) return;
  clock.seen.add(mark);
  lifecycle('turn.mark', {
    ...fields, turnId: clock.turnId, mark, ms: Math.max(0, Date.now() - clock.startedAt),
    ...(clock.harness ? { harness: clock.harness } : {}),
  });
}

// ---------------------------------------------------------------- reading

/** One turn's breakdown, in milliseconds since submit unless named `…To…`
 * (a span between two marks). A span whose marks the turn did not reach is
 * absent. */
export interface TurnBreakdown {
  turnId: string;
  harness?: string;
  session?: string;
  /** Whether the vendor process was reused (persistent) rather than spawned. */
  reused?: boolean;
  marks: Partial<Record<TurnMarkName, number>>;
  /** submit -> the worker took the turn (the window's own work + the hop). */
  submitToAccepted?: number;
  /** submit -> the vendor process spawned or reused: ClikCode's, entirely. */
  submitToSpawn?: number;
  /** spawn -> the handshake done, the prompt about to go. */
  spawnToReady?: number;
  readyToPromptSent?: number;
  /** prompt sent -> the vendor's first byte: the harness's own time. */
  promptToFirstByte?: number;
  /** ready -> first byte (the span the vendor was waited on from "ready"). */
  readyToFirstByte?: number;
  firstByteToFirstEvent?: number;
  firstEventToFirstText?: number;
  /** The prompt echo: submit -> the window painted the user's message. */
  submitToFirstPaint?: number;
  /** The first answer text reached the screen: first event -> first text paint. */
  firstEventToFirstPaint?: number;
  /** first text produced -> painted: the window's render lag. */
  firstTextToTextPaint?: number;
  /** submit -> the first answer text on screen (the user's wait). */
  submitToTextPaint?: number;
  total?: number;
  /** The harness's own time: prompt-sent .. first-byte. */
  vendorMs?: number;
  /** Everything else up to the first answer text being seen -- ClikCode's. */
  clikcodeMs?: number;
}

type Raw = Record<string, unknown>;

function parseLine(line: string | Raw): Raw | undefined {
  if (typeof line !== 'string') return line;
  try { return JSON.parse(line) as Raw; } catch { return undefined; }
}

const span = (marks: TurnBreakdown['marks'], from: TurnMarkName, to: TurnMarkName): number | undefined => {
  const a = marks[from];
  const b = marks[to];
  return a !== undefined && b !== undefined ? Math.max(0, b - a) : undefined;
};

/** The breakdown of ONE turn from its `turn.mark` lines (other lines, and
 * marks of other turns, are ignored; the first line of each mark wins). */
export function turnLatency(lines: ReadonlyArray<string | Raw>, turnId?: string): TurnBreakdown | undefined {
  const marks: TurnBreakdown['marks'] = {};
  let id = turnId;
  let harness: string | undefined;
  let session: string | undefined;
  let reused: boolean | undefined;
  for (const line of lines) {
    const entry = parseLine(line);
    if (!entry || entry.event !== 'turn.mark' || typeof entry.turnId !== 'string' || typeof entry.mark !== 'string' || typeof entry.ms !== 'number') continue;
    if (id === undefined) id = entry.turnId;
    if (entry.turnId !== id) continue;
    const mark = entry.mark as TurnMarkName;
    if (!(TURN_MARKS as readonly string[]).includes(mark) || marks[mark] !== undefined) continue;
    marks[mark] = entry.ms;
    if (typeof entry.harness === 'string' && !harness) harness = entry.harness;
    if (typeof entry.session === 'string' && !session) session = entry.session;
    if (mark === 'spawned' && typeof entry.reused === 'boolean') reused = entry.reused;
  }
  if (id === undefined || !Object.keys(marks).length) return undefined;
  const out: TurnBreakdown = { turnId: id, marks };
  if (harness) out.harness = harness;
  if (session) out.session = session;
  if (reused !== undefined) out.reused = reused;
  const set = <K extends keyof TurnBreakdown>(key: K, value: TurnBreakdown[K] | undefined): void => { if (value !== undefined) out[key] = value; };
  set('submitToAccepted', span(marks, 'submit', 'accepted'));
  // `ms` is already since submit; without a submit mark (a headless turn) the
  // clock's own start stands in for it.
  set('submitToSpawn', marks.spawned);
  set('spawnToReady', span(marks, 'spawned', 'ready'));
  set('readyToPromptSent', span(marks, 'ready', 'prompt-sent'));
  set('promptToFirstByte', span(marks, 'prompt-sent', 'first-byte'));
  set('readyToFirstByte', span(marks, 'ready', 'first-byte'));
  set('firstByteToFirstEvent', span(marks, 'first-byte', 'first-event'));
  set('firstEventToFirstText', span(marks, 'first-event', 'first-text'));
  set('submitToFirstPaint', marks['first-paint']);
  set('firstEventToFirstPaint', span(marks, 'first-event', 'first-text-paint'));
  set('firstTextToTextPaint', span(marks, 'first-text', 'first-text-paint'));
  set('submitToTextPaint', marks['first-text-paint']);
  set('total', marks.end);
  const seen = marks['first-text-paint'] ?? marks['first-text'] ?? marks['first-event'];
  const vendor = out.promptToFirstByte ?? out.readyToFirstByte;
  if (vendor !== undefined) {
    out.vendorMs = vendor;
    if (seen !== undefined) out.clikcodeMs = Math.max(0, seen - vendor);
  }
  return out;
}

/** Every turn in a run of log entries, oldest first. */
export function turnsLatency(lines: ReadonlyArray<string | Raw>): TurnBreakdown[] {
  const byTurn = new Map<string, Raw[]>();
  for (const line of lines) {
    const entry = parseLine(line);
    if (!entry || entry.event !== 'turn.mark' || typeof entry.turnId !== 'string') continue;
    const list = byTurn.get(entry.turnId);
    if (list) list.push(entry); else byTurn.set(entry.turnId, [entry]);
  }
  return [...byTurn.entries()].map(([id, entries]) => turnLatency(entries, id)).filter((turn): turn is TurnBreakdown => Boolean(turn));
}

const NUMERIC: ReadonlyArray<keyof TurnBreakdown> = [
  'submitToAccepted', 'submitToSpawn', 'spawnToReady', 'readyToPromptSent', 'promptToFirstByte', 'readyToFirstByte', 'firstByteToFirstEvent',
  'firstEventToFirstText', 'submitToFirstPaint', 'firstEventToFirstPaint', 'firstTextToTextPaint', 'submitToTextPaint', 'total', 'vendorMs', 'clikcodeMs',
];

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : Math.round(((sorted[mid - 1]! + sorted[mid]!) / 2));
}

/** The median of each span per harness, over the turns that reached it. */
export function medianLatencyByHarness(turns: readonly TurnBreakdown[]): Array<{ harness: string; turns: number; medians: Partial<Record<keyof TurnBreakdown, number>> }> {
  const groups = new Map<string, TurnBreakdown[]>();
  for (const turn of turns) {
    const key = turn.harness ?? 'unknown';
    const list = groups.get(key);
    if (list) list.push(turn); else groups.set(key, [turn]);
  }
  return [...groups.entries()].map(([harness, list]) => {
    const medians: Partial<Record<keyof TurnBreakdown, number>> = {};
    for (const key of NUMERIC) {
      const values = list.map((turn) => turn[key]).filter((value): value is number => typeof value === 'number');
      if (values.length) medians[key] = median(values);
    }
    return { harness, turns: list.length, medians };
  }).sort((a, b) => a.harness.localeCompare(b.harness));
}

const COLUMNS: ReadonlyArray<{ head: string; key: keyof TurnBreakdown }> = [
  { head: 'echo', key: 'submitToFirstPaint' },
  { head: 'accept', key: 'submitToAccepted' },
  { head: 'spawn', key: 'submitToSpawn' },
  { head: 'ready', key: 'spawnToReady' },
  { head: 'vendor', key: 'vendorMs' },
  { head: 'event', key: 'firstByteToFirstEvent' },
  { head: 'textpaint', key: 'submitToTextPaint' },
  { head: 'clikcode', key: 'clikcodeMs' },
  { head: 'total', key: 'total' },
];

const cell = (value: unknown): string => (typeof value === 'number' ? String(Math.round(value)) : '-');

/** The per-turn table, then the median per harness. Plain text. */
export function formatLatencyTable(turns: readonly TurnBreakdown[]): string {
  if (!turns.length) return 'No latency marks yet: run a turn on a build with turn marks.';
  const rows: string[][] = [['turn', 'harness', 'reused', ...COLUMNS.map((column) => column.head)]];
  for (const turn of turns) {
    rows.push([turn.turnId.slice(0, 8), turn.harness ?? '-', turn.reused === undefined ? '-' : String(turn.reused), ...COLUMNS.map((column) => cell(turn[column.key]))]);
  }
  const medians = medianLatencyByHarness(turns);
  const summary: string[][] = [['median', 'harness', 'turns', ...COLUMNS.map((column) => column.head)]];
  for (const group of medians) summary.push(['', group.harness, String(group.turns), ...COLUMNS.map((column) => cell(group.medians[column.key]))]);
  const draw = (table: string[][]): string[] => {
    const widths = table[0]!.map((_, index) => Math.max(...table.map((row) => row[index]!.length)));
    return table.map((row) => row.map((value, index) => (index < 2 ? value.padEnd(widths[index]!) : value.padStart(widths[index]!))).join('  ').trimEnd());
  };
  return [...draw(rows), '', ...draw(summary), '', 'ms since submit; vendor = prompt-sent..first-byte, clikcode = everything else up to the first answer text on screen.'].join('\n');
}
