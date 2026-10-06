/** What a tool row shows, decided once for every client. The terminal paints
 * these choices with chalk (activity-line.ts, prompter.ts); the VS Code
 * webview paints the same choices as HTML. Nothing here styles anything, so
 * the webview can bundle it. */

import type { FileDiff, DiffLine } from '../../agent/line-diff.js';
import type { HarnessActivityEvent, ToolCategory } from '../prompter.js';
import { visibleSlice } from '../../tui/render/width.js';
import { compactCount, formatDuration } from './format.js';
import { TOOL_CATEGORY } from './tool-category.js';
import { isAgentToolName } from './tools.js';
import { SPIN_MS, SPIN_PHASES } from './timings.js';

/** How much of a tool's work a transcript row shows. Enough to recognise the
 * edit or command at a glance without the trail crowding out the answer. */
export const ACTIVITY_PREVIEW_LINES = 8;

/** Preview budget per kind of work, because one number cannot fit all of it.
 *
 * Eight lines is right for a diff -- the edit IS the lines -- and far too
 * generous for everything else. A read's row already names the file, so its
 * output repeats what the label said; a command's first lines are the ones
 * that matter and the rest is scroll. At 8 for everything, three tool calls
 * filled half a phone screen and the answer they were serving fell off the
 * bottom. */
export const CATEGORY_PREVIEW_LINES: Readonly<Record<ToolCategory, number>> = {
  edit: ACTIVITY_PREVIEW_LINES,
  run: 3,
  search: 3,
  fetch: 2,
  read: 0,
};

/** Lines a settled tool row may show, given what kind of work it was. */
export function previewLinesFor(category?: ToolCategory): number {
  return category ? CATEGORY_PREVIEW_LINES[category] : ACTIVITY_PREVIEW_LINES;
}

/** Lines of a running call's output shown under it. */
export const LIVE_OUTPUT_LINES = 3;
/** Diff lines an edit's row shows, across all its files. */
export const DIFF_PREVIEW_LINES = 12;
/** Files of one change shown before the rest are counted. */
export const DIFF_PREVIEW_FILES = 4;

/** Whether `next` is another frame of the call `prior` records. One provider
 * may publish pending/running/progress frames for the same tool: by id, a
 * call's row is found whatever state it is in (detail that arrives after it
 * finished, a final diff, belongs in that row); without an id only a still
 * open row with the same label can be the same call. */
export function sameCall(prior: HarnessActivityEvent, next: HarnessActivityEvent): boolean {
  if (next.id) return prior.id === next.id;
  return prior.kind === 'tool-start' && prior.label === next.label;
}

/** A later frame of a call, merged into what the row already knew. */
export function mergeActivity(prior: HarnessActivityEvent, next: HarnessActivityEvent): HarnessActivityEvent {
  return {
    ...next,
    // A finished call stays finished: a later frame without a status adds
    // its detail but cannot reopen it.
    ...(next.kind === 'tool-start' && prior.kind !== 'tool-start' ? { kind: prior.kind } : {}),
    ...(next.label === 'tool' || !next.label ? { label: prior.label } : {}),
    // A completion frame routinely carries neither the name nor the input
    // the category was derived from. The row keeps what its start knew.
    ...(next.category ? {} : prior.category ? { category: prior.category } : {}),
    ...(next.agent ? {} : prior.agent ? { agent: prior.agent } : {}),
    ...(next.swarm ? {} : prior.swarm ? { swarm: prior.swarm } : {}),
    ...(next.diff ? {} : prior.diff ? { diff: prior.diff } : {}),
    ...(next.call ? {} : prior.call ? { call: prior.call } : {}),
    ...(next.childTools !== undefined || prior.childTools === undefined ? {} : { childTools: prior.childTools }),
    ...(next.childTokens !== undefined || prior.childTokens === undefined ? {} : { childTokens: prior.childTokens }),
    ...(next.durationMs !== undefined || prior.durationMs === undefined ? {} : { durationMs: prior.durationMs }),
    ...(next.exitCode !== undefined || prior.exitCode === undefined ? {} : { exitCode: prior.exitCode }),
    // Likewise its output: a completion that carries none (most do not)
    // used to erase every line the running tool had streamed.
    ...(next.output?.length || !prior.output?.length ? {} : {
      output: prior.output,
      ...(prior.outputOmitted ? { outputOmitted: prior.outputOmitted } : {}),
      ...(prior.outputTail ? { outputTail: true } : {}),
      ...(prior.outputHead ? { outputHead: prior.outputHead } : {}),
    }),
  };
}

export type OutputPreview = { lines: string[]; hidden: number; fromEnd: boolean };

/** A tool's output under its row, at most `budget` lines. A command's result
 * is at its end, and so is all a producer kept of a long stream
 * (`outputTail`), so those show their LAST lines, the earlier ones counted
 * above them; anything else shows its first lines, the rest counted below.
 * Showing the first of a kept tail put a long command's middle on screen. */
export function outputPreview(event: Pick<HarnessActivityEvent, 'output' | 'outputOmitted' | 'outputTail' | 'category'>, budget: number): OutputPreview {
  const output = event.output ?? [];
  const fromEnd = event.outputTail === true || (event.category === 'run' && !event.outputOmitted);
  if (!output.length || budget <= 0) return { lines: [], hidden: 0, fromEnd };
  const lines = fromEnd ? output.slice(-budget) : output.slice(0, budget);
  return { lines, hidden: output.length - lines.length + (event.outputOmitted ?? 0), fromEnd };
}

/** A command's head and tail, as Grok and Cursor show a long one. */
export const COMMAND_HEAD_LINES = 2;
export const COMMAND_TAIL_LINES = 3;

export type CommandPreview = { head: string[]; hidden: number; tail: string[] };

/** A command's output as its first lines -- what it set out to do -- and its
 * last -- how it ended -- with the middle counted. From the whole output, or
 * from a tail the producer cut that kept its head (`outputHead`); undefined
 * for anything else, including a cut tail without one, whose first kept line
 * is somewhere in the middle (outputPreview shows that one's end). Short
 * output is shown whole. */
export function commandOutputPreview(event: Pick<HarnessActivityEvent, 'output' | 'outputOmitted' | 'outputHead' | 'category'>): CommandPreview | undefined {
  const output = event.output ?? [];
  if (event.category !== 'run' || !output.length) return undefined;
  if (event.outputOmitted) {
    if (!event.outputHead?.length || output.length < COMMAND_TAIL_LINES) return undefined;
    const head = event.outputHead.slice(0, COMMAND_HEAD_LINES);
    return { head, hidden: output.length + event.outputOmitted - head.length - COMMAND_TAIL_LINES, tail: output.slice(-COMMAND_TAIL_LINES) };
  }
  if (output.length <= COMMAND_HEAD_LINES + COMMAND_TAIL_LINES) return { head: [...output], hidden: 0, tail: [] };
  return { head: output.slice(0, COMMAND_HEAD_LINES), hidden: output.length - COMMAND_HEAD_LINES - COMMAND_TAIL_LINES, tail: output.slice(-COMMAND_TAIL_LINES) };
}

export type DiffPreview = {
  files: Array<{ file: FileDiff; lines: DiffLine[] }>;
  /** Width of the line-number gutter; 0 when no line carries a number. */
  gutter: number;
  hiddenLines: number;
  moreFiles: number;
};

/** The part of a change a row shows: at most `budget` lines across the
 * first DIFF_PREVIEW_FILES files, with what was left out counted. */
export function diffPreview(files: readonly FileDiff[], budget: number): DiffPreview {
  const shown = files.slice(0, DIFF_PREVIEW_FILES);
  const numbers = shown.flatMap((file) => file.lines.flatMap((line) => line.line === undefined ? [] : [line.line]));
  let left = budget;
  let hiddenLines = 0;
  const kept = shown.map((file) => {
    const lines = file.lines.slice(0, Math.max(0, left));
    left -= lines.length;
    hiddenLines += file.lines.length - lines.length + (file.omitted ?? 0);
    return { file, lines };
  });
  return { files: kept, gutter: numbers.length ? String(Math.max(...numbers)).length : 0, hiddenLines, moreFiles: files.length - shown.length };
}

/** What an edit added and removed in all. */
export function diffTotals(files: readonly FileDiff[]): { additions: number; removals: number } {
  return {
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    removals: files.reduce((sum, file) => sum + file.removals, 0),
  };
}

export type Thought = { id?: string; text: string };

const THOUGHT_LIMIT = 2000;

/** A reasoning event added to the thought on screen.
 *
 * Transports differ: some send each reasoning item whole, some its running
 * total, some every 1-3 token fragment. Replacing the row with each event
 * made the last kind a flicker of single words. So within one reasoning item
 * (same id, or no ids at all) text that extends the thought -- or repeats
 * it -- replaces it, and anything else is appended; a new item id starts
 * afresh. Fragments arrive trimmed by some transports, so one without its own
 * spacing is joined with a space -- a word split mid-way reads better than
 * words run together. */
export function appendThought(prior: Thought | undefined, label: string, id?: string): Thought | undefined {
  const fragment = label.replace(/\s+/g, ' ');
  const trimmed = fragment.trim();
  if (!trimmed || trimmed.toLowerCase() === 'thinking') return prior;
  const withId = (text: string): Thought => ({ ...(id === undefined ? {} : { id }), text: text.length > THOUGHT_LIMIT ? text.slice(-THOUGHT_LIMIT) : text });
  if (!prior || prior.id !== id) return withId(trimmed);
  if (trimmed.startsWith(prior.text)) return withId(trimmed);
  const joined = /^[\s.,;:!?)\]'"]/.test(fragment) || /\s$/.test(prior.text) ? `${prior.text}${fragment}` : `${prior.text} ${fragment}`;
  return withId(joined.replace(/\s+/g, ' ').trim());
}

/** A sub-agent's work so far, as Claude Code counts it. */
export function toolUses(count: number): string {
  return `${count} tool use${count === 1 ? '' : 's'}`;
}

/** The parent row's count once one of its sub-agent's calls starts. */
export function withChildTool<T extends Pick<HarnessActivityEvent, 'childTools'>>(parent: T, child: Pick<HarnessActivityEvent, 'kind'>): T {
  return child.kind === 'tool-start' ? { ...parent, childTools: (parent.childTools ?? 0) + 1 } : parent;
}

/** What a sub-agent is doing now, for its parent's row: the label of its
 * latest call or thought, cleared when that call finishes. */
export function childActivity(current: string | undefined, event: HarnessActivityEvent): string | undefined {
  if (event.kind === 'tool-start' || event.kind === 'thinking') return event.label;
  if (event.kind === 'tool-done' || event.kind === 'tool-error') return undefined;
  return current;
}

export type OpenTool = { label: string; category?: ToolCategory; agent?: boolean; swarmProvider?: string };

/** What the status line says while a call runs: the category's verb, and
 * what it is working on when the label names it -- `Read(src/app.ts)` is
 * "reading app.ts", `Bash(npm test)` is "running tests", a codex command
 * label `git status` is "running git". A label that names nothing gets the
 * bare verb rather than a guess. */
export function toolStatusVerb(tool: OpenTool): string {
  const name = tool.label.split('(')[0]!.trim();
  if (tool.swarmProvider) return `waiting on ${tool.swarmProvider}`;
  if (tool.agent || (tool.category !== 'run' && isAgentToolName(tool.label))) return 'waiting on agent';
  const argument = /^[^(]*\((.*)\)$/s.exec(tool.label)?.[1]?.trim();
  const subject = (value: string, width = 32): string => visibleSlice(value, width);
  switch (tool.category) {
    case 'run': {
      // A shell row's label is often the prompt-shaped `$ git log`.
      const command = (argument ?? tool.label).replace(/^\s*\$\s+/, '');
      if (/(?:^|[\s/])(?:test|tests|vitest|jest|pytest|mocha|rspec|phpunit)\b|\btest:/.test(command)) return 'running tests';
      const program = command.split(/\s+/).find((word) => word && !/^\w+=/.test(word) && word !== 'sudo');
      return program ? `running ${subject(program.split('/').pop() || program, 24)}` : 'running';
    }
    case 'read':
    case 'edit': {
      const verb = TOOL_CATEGORY[tool.category].verb;
      const path = argument?.split(/[\s,]+/)[0];
      const file = path?.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
      return file ? `${verb} ${subject(file)}` : verb;
    }
    case 'search':
    case 'fetch':
      return TOOL_CATEGORY[tool.category].verb;
    default:
      return name ? `running ${subject(name, 24)}` : 'running';
  }
}

function swarmStatusName(swarm: HarnessActivityEvent['swarm']): string | undefined {
  if (!swarm) return undefined;
  return swarm.usageLeft === undefined ? swarm.displayName : `${swarm.displayName} (${Math.round(swarm.usageLeft)}% left)`;
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
      ...(event.swarm?.displayName || prior?.swarmProvider ? { swarmProvider: swarmStatusName(event.swarm) ?? prior?.swarmProvider } : {}),
    });
  }
  else if (event.kind === 'tool-done' || event.kind === 'tool-error') {
    if (!next.delete(key) && !event.id) {
      const matchingKey = [...next].reverse().find(([, tool]) => tool.label === event.label)?.[0];
      if (matchingKey) next.delete(matchingKey);
    }
  }
  return { activeTools: next, ...openToolsStatus(next) };
}

/** What the status line says about the calls still open: the newest one's
 * verb and kind of work, or "thinking" when none is. */
export function openToolsStatus(activeTools: ReadonlyMap<string, OpenTool>): { phase: string; category?: ToolCategory } {
  const running = [...activeTools.values()];
  const current = running[running.length - 1];
  if (!current) return { phase: 'thinking' };
  // Providers working inside this turn name the status line together, so
  // Claude waiting on Cursor and Codex reads as that, not as the newest verb.
  const providers = [...new Set(running.flatMap((tool) => tool.swarmProvider ? [tool.swarmProvider] : []))];
  return {
    phase: providers.length ? `waiting on ${providers.join(', ')}` : toolStatusVerb(current),
    ...(current.category ? { category: current.category } : {}),
  };
}


/** A fixed 4x4 field of identical tiny dots. Four diagonal phases move through
 * the same compact shape without changing its dimensions. */
export function waitingSpinnerFrame(frame: number): [boolean[], boolean[], boolean[], boolean[]] {
  const phase = Math.abs(frame) % SPIN_PHASES;
  return Array.from({ length: 4 }, (_, row) =>
    Array.from({ length: 4 }, (_, column) => (row + column + phase) % 4 < 2),
  ) as [boolean[], boolean[], boolean[], boolean[]];
}

/** Pack the logical 4x4 animation into two adjacent Braille cells. A Braille
 * cell is itself a 2x4 dot matrix, so this preserves all sixteen positions in
 * one terminal row without the four-row gap shown by ordinary periods. */
export function waitingSpinnerGlyph(frame: number): string {
  const grid = waitingSpinnerFrame(frame);
  const bit = (column: number, row: number): number => {
    const positions = [[0, 1, 2, 6], [3, 4, 5, 7]] as const;
    return grid[row]![column] ? 1 << positions[column % 2]![row] : 0;
  };
  return [0, 2].map((start) => String.fromCodePoint(0x2800
    | bit(start, 0) | bit(start, 1) | bit(start, 2) | bit(start, 3)
    | bit(start + 1, 0) | bit(start + 1, 1) | bit(start + 1, 2) | bit(start + 1, 3))).join('');
}

/** How a running call is drawn: a command and a sub-agent say so (and spin
 * in their own colour); anything else is just its label. */
export function liveWaitKind(event: Pick<HarnessActivityEvent, 'kind' | 'agent' | 'category' | 'label'>): 'command' | 'agent' | undefined {
  if (event.kind !== 'tool-start') return undefined;
  if (event.agent) return 'agent';
  if (event.category !== 'run' && isAgentToolName(event.label)) return 'agent';
  if (event.category === 'run') return 'command';
  return undefined;
}

/** A running turn's clock, as data: when it began, and the time spent
 * waiting on the user (an approval), which the clock leaves out --
 * `pausedAt` while one is up. */
export type TurnClock = { startedAt: number; pausedMs: number; pausedAt?: number };

export function startTurnClock(now: number): TurnClock {
  return { startedAt: now, pausedMs: 0 };
}

/** A turn joined mid-way counts from when it really started. */
export function joinTurnClock(clock: TurnClock, startedAt: number): TurnClock {
  return startedAt < clock.startedAt ? { ...clock, startedAt } : clock;
}

/** An approval is up: the clock stops until it is answered. */
export function pauseTurnClock(clock: TurnClock, now: number): TurnClock {
  return clock.pausedAt === undefined ? { ...clock, pausedAt: now } : clock;
}

/** An approval was answered (or the turn ended under one): the clock runs
 * again. */
export function resumeTurnClock(clock: TurnClock, now: number): TurnClock {
  if (clock.pausedAt === undefined) return clock;
  return { startedAt: clock.startedAt, pausedMs: clock.pausedMs + now - clock.pausedAt };
}

/** The turn's running time, less any spent waiting on an approval. */
export function turnElapsedMs(clock: TurnClock, now: number): number {
  return Math.max(0, now - clock.startedAt - clock.pausedMs - (clock.pausedAt === undefined ? 0 : now - clock.pausedAt));
}

/** What the turn is waiting on besides the model: a call still running, or
 * an approval on screen. */
export type TurnWaits = { toolsRunning: boolean; approval: boolean };

/** Whether the band ticks at the spinner's rate: the whole turn, except
 * while an approval waits on the user -- then it ticks once a second, for
 * the clock. How long since data last arrived is not shown: an agent quiet
 * while it waits on something is still working. */
export function turnAnimating(waits: TurnWaits): boolean {
  return !waits.approval;
}

/** How long until the band next ticks: the spinner's step while animating,
 * otherwise just past the clock's next whole second. */
export function nextTurnTickMs(clock: TurnClock, now: number, animating: boolean): number {
  return animating ? SPIN_MS : 1000 - (turnElapsedMs(clock, now) % 1000) + 5;
}

/** What follows a finished call: a non-zero exit and a run of a second or
 * more -- the exceptions, since every call exits 0 in under a second. */
export function activityOutcome(event: Pick<HarnessActivityEvent, 'kind' | 'exitCode' | 'durationMs' | 'childTools' | 'childTokens'>): { parts: string[]; failed: boolean } | undefined {
  if (event.kind !== 'tool-done' && event.kind !== 'tool-error') return undefined;
  const failed = event.kind === 'tool-error' || (event.exitCode !== undefined && event.exitCode !== 0);
  const parts = [
    ...(event.childTools ? [toolUses(event.childTools)] : []),
    // A sub-agent's spend, as Claude Code shows it: "30k tokens".
    ...(event.childTokens ? [`${compactCount(event.childTokens)} tokens`] : []),
    ...(event.exitCode !== undefined && event.exitCode !== 0 ? [`exit ${event.exitCode}`] : []),
    ...(event.durationMs !== undefined && event.durationMs >= 1000 ? [formatDuration(event.durationMs)] : []),
  ];
  return parts.length ? { parts, failed } : undefined;
}
