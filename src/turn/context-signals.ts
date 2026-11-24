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
 * Dependency-free, so tests and the report can use it. */

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

/** The files a conversation has read and not changed since (HarnessSession.readFiles), newest last. */
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

const isHindsight = (name: string | undefined): boolean => /(^|[_.:])hindsight$/i.test(name ?? '');

/** One turn's signals, from its tool events. `files` is the conversation's list (kept on the
 * session), changed in place. A subagent's calls are its own context and are not counted. */
export function createSignalTracker(files: string[]): { note(event: ToolEvent): void; counts(request: string): SignalCounts } {
  const hindsightIds = new Set<string>();
  const started = new Set<string>();
  const turn = emptyCounts();
  const forget = (path: string): void => {
    const at = files.indexOf(path);
    if (at >= 0) files.splice(at, 1);
  };
  return {
    note(event) {
      if (event.parentId) return;
      const name = event.call?.name;
      if (event.kind === 'tool-start') {
        if (event.id) {
          if (started.has(event.id)) return;
          started.add(event.id);
        }
        if (isHindsight(name)) {
          turn.hindsight += 1;
          if (event.id) hindsightIds.add(event.id);
          return;
        }
        const path = pathOf(event.call?.input);
        if (!path) return;
        if (event.category === 'read') {
          if (files.includes(path)) { turn.reReads += 1; forget(path); }
          files.push(path);
          if (files.length > KEPT_FILES) files.splice(0, files.length - KEPT_FILES);
        } else if (event.category === 'edit') forget(path);
        return;
      }
      if ((event.kind === 'tool-done' || event.kind === 'tool-error') && (isHindsight(name) || (event.id !== undefined && hindsightIds.has(event.id)))) {
        if (event.id) hindsightIds.delete(event.id);
        if (event.kind === 'tool-error' || EMPTY_HINDSIGHT.test((event.output ?? []).join('\n'))) turn.hindsightEmpty += 1;
      }
    },
    counts(request) {
      return { ...turn, turns: 1, corrections: isCorrection(request) ? 1 : 0 };
    },
  };
}
