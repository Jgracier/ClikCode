/** What a turn shows about how much its model lost to compaction, read from what the turn did
 * anyway -- no extra call, no extra tokens. Context auto-tune (turn/context-tune.ts) compares
 * these on turns whose context was cut below the vendor's default against turns that had it all:
 *
 * - a file read again that was read before and not changed since (it no longer had it);
 * - a hindsight search that found nothing (it looked for something that was never there, or
 *   asked about the wrong thing);
 * - how often it searched hindsight at all: a model that stops looking back loses quietly
 *   (Haiku at 100k scored low because it stopped searching, not because the record was gone);
 * - the user correcting it or repeating themselves ("I already said", "as I told you"), which
 *   is also how a re-asked question shows.
 *
 * No ClikCode imports, so tests and the report can use it. */

import { isAbsolute, resolve } from 'node:path';

export interface SignalCounts {
  turns: number;
  reReads: number;
  hindsight: number;
  hindsightEmpty: number;
  corrections: number;
}

export const emptyCounts = (): SignalCounts => ({ turns: 0, reReads: 0, hindsight: 0, hindsightEmpty: 0, corrections: 0 });

export function addCounts(into: SignalCounts, add: SignalCounts): void {
  into.turns += add.turns;
  into.reReads += add.reReads;
  into.hindsight += add.hindsight;
  into.hindsightEmpty += add.hindsightEmpty;
  into.corrections += add.corrections;
}

/** The files a conversation has read and not changed since (HarnessSession.readFiles), newest last:
 * the path, or `<path>#<part>` for part of one. */
const KEPT_FILES = 400;

const CORRECTION = /\b(i (already|just) (told|said|asked|gave|showed)|as i (said|told you|mentioned)|i told you|we (already|just) (did|went over|covered)|you (already|just) (did|asked|said|read)|did you forget|you forgot|i said (that|this|it|already)|not what i (said|asked)|like i said|remember (i|we|that) )/i;

/** The user's request reads as a correction or a repeat. */
export const isCorrection = (request: string): boolean => CORRECTION.test(request);

const EMPTY_HINDSIGHT = /does not come up in this chat|this call has none|are not both in this chat|cannot read at=/i;

interface ToolEvent {
  kind: string;
  id?: string;
  category?: string;
  parentId?: string;
  call?: { name: string; input?: Record<string, unknown> };
  output?: readonly string[];
}

function pathOf(input: Record<string, unknown> | undefined): string | undefined {
  for (const key of ['file_path', 'filePath', 'path', 'absolute_path', 'target_file', 'file']) {
    const value = input?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** The part of a file a read tool asked for: a page read after another page is not a re-read. */
function rangeOf(input: Record<string, unknown> | undefined): string {
  const part = ['offset', 'limit', 'start_line', 'end_line', 'startLine', 'endLine', 'line', 'lines', 'view_range', 'range']
    .map((key) => input?.[key]).filter((value) => value !== undefined && value !== null);
  return part.length ? JSON.stringify(part) : '';
}

/** A shell call's command line: Claude's `command` string, Codex's argv (`bash -lc <line>`). */
function commandOf(input: Record<string, unknown> | undefined): string | undefined {
  const value = input?.command ?? input?.cmd;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
    const shell = value.findIndex((part) => part === '-c' || part === '-lc');
    return shell >= 0 && typeof value[shell + 1] === 'string' ? value[shell + 1] : value.join(' ');
  }
  return undefined;
}

const unquote = (word: string): string => word.replace(/^(['"])(.*)\1$/, '$2');
const SHELL_READER = /^(cat|head|tail|nl|less|more|bat|sed)$/;

/** The files a shell line reads whole or in part, each with the part asked for -- `cat a`,
 * `head -n 50 a`, `sed -n 1,80p a` -- or undefined when the line does anything else (a pipe into
 * another reader still reads; a redirect into a file, `sed -i`, or any other program is not
 * a read). Agents that read through the shell (Codex always does) show re-reads this way. */
export function shellReads(line: string): { path: string; range: string }[] | undefined {
  if (/[<>`$]|\btee\b/.test(line)) return undefined;
  const found: { path: string; range: string }[] = [];
  for (const segment of line.split(/&&|;|\|\|/)) {
    const first = segment.split('|')[0]!.trim();
    if (!first) continue;
    const words = first.split(/\s+/).map(unquote);
    const program = words[0]!.replace(/^.*\//, '');
    if (!SHELL_READER.test(program)) return undefined;
    if (program === 'sed' && !words.includes('-n')) return undefined;
    if (words.some((word) => word === '-i' || word.startsWith('-i') && program === 'sed' || word === '-f')) return undefined;
    const flags: string[] = [];
    const paths: string[] = [];
    for (let index = 1; index < words.length; index += 1) {
      const word = words[index]!;
      if (word.startsWith('-')) {
        flags.push(word);
        if ((word === '-n' || word === '-c') && program !== 'sed' && words[index + 1] !== undefined) flags.push(words[++index]!);
        continue;
      }
      if (program === 'sed' && /^(\d+(,\d+)?p|\/.*\/p?|\$p|\d+,\$p)$/.test(word)) { flags.push(word); continue; }
      paths.push(word);
    }
    for (const path of paths) found.push({ path, range: program === 'cat' || program === 'bat' || program === 'less' || program === 'more' || program === 'nl' ? '' : `${program} ${flags.join(' ')}` });
  }
  return found;
}

const words = (line: string): string[] => line.split(/[\s;&|<>()]+/).map(unquote).filter(Boolean);

const isHindsight = (name: string | undefined): boolean => /(^|[_.:])hindsight$/i.test(name ?? '');

/** One turn's signals, from its tool events. `files` is the conversation's list (kept on the
 * session), changed in place. A subagent's calls are its own context and are not counted. */
export function createSignalTracker(files: string[], cwd?: string): { note(event: ToolEvent): void; counts(request: string): SignalCounts } {
  const hindsightIds = new Set<string>();
  const started = new Set<string>();
  const turn = emptyCounts();
  // One entry per file and part read: `<path>` for the whole of it, `<path>#<part>` for a page.
  const absolute = (path: string): string => (cwd && !isAbsolute(path) ? resolve(cwd, path) : path);
  const forget = (path: string): void => {
    const file = absolute(path);
    for (let at = files.length - 1; at >= 0; at -= 1) {
      if (files[at] === file || files[at]!.startsWith(`${file}#`)) files.splice(at, 1);
    }
  };
  const noteRead = (path: string, range: string): void => {
    const key = range ? `${absolute(path)}#${range}` : absolute(path);
    const at = files.indexOf(key);
    if (at >= 0) { turn.reReads += 1; files.splice(at, 1); }
    files.push(key);
    if (files.length > KEPT_FILES) files.splice(0, files.length - KEPT_FILES);
  };
  const reads = new Map<string, { category?: string; path?: string; range?: string }>();
  const settle = (id: string): void => {
    const read = reads.get(id);
    reads.delete(id);
    if (read?.category === 'read' && read.path) noteRead(read.path, read.range ?? '');
  };
  // Held reads come first when a later call may change a file, so the order stays as it ran.
  const settleAll = (): void => { for (const id of [...reads.keys()]) settle(id); };
  return {
    note(event) {
      if (event.parentId) return;
      const name = event.call?.name;
      if (event.kind === 'tool-start') {
        // A call arrives in frames: Claude's first names the tool alone, before its arguments have
        // streamed. A search or a command counts once, from the first frame that says what it does.
        if (event.id && started.has(event.id)) return;
        const seen = (): void => { if (event.id) started.add(event.id); };
        if (isHindsight(name)) {
          seen();
          turn.hindsight += 1;
          if (event.id) hindsightIds.add(event.id);
          return;
        }
        const input = event.call?.input;
        const line = event.category === 'run' || event.category === undefined ? commandOf(input) : undefined;
        if (line !== undefined) {
          seen();
          settleAll();
          const shell = shellReads(line);
          if (shell) for (const { path, range } of shell) noteRead(path, range);
          // Anything else the line does may change a file it names.
          else for (const word of words(line)) forget(word);
          return;
        }
        // A file call's arguments can arrive a field at a time (claude-agent-acp sends `{file_path}`,
        // then `{file_path, offset}`, then the whole input, and a later frame may drop the kind), so a
        // read is held by id, each frame refining it, and counted when the call ends.
        const held = event.id ? reads.get(event.id) : undefined;
        const category = event.category ?? held?.category;
        const path = pathOf(input);
        if (!path) {
          if (event.id && category && !held) reads.set(event.id, { category });
          return;
        }
        if (category === 'edit') { seen(); settleAll(); forget(path); return; }
        if (!event.id) { if (category === 'read') noteRead(path, rangeOf(input)); return; }
        reads.set(event.id, { category, path, range: rangeOf(input) });
        return;
      }
      if ((event.kind === 'tool-done' || event.kind === 'tool-error') && event.id) settle(event.id);
      if ((event.kind === 'tool-done' || event.kind === 'tool-error') && (isHindsight(name) || (event.id !== undefined && hindsightIds.has(event.id)))) {
        if (event.id) hindsightIds.delete(event.id);
        if (event.kind === 'tool-error' || EMPTY_HINDSIGHT.test((event.output ?? []).join('\n'))) turn.hindsightEmpty += 1;
      }
    },
    counts(request) {
      // A call the turn never saw end (cut off, or its end carried no id) still read what it named.
      settleAll();
      return { ...turn, turns: 1, corrections: isCorrection(request) ? 1 : 0 };
    },
  };
}
