/** Undoing a turn from the diffs its tool calls reported: the one
 * implementation both the VS Code "Undo all" and the terminal's `/undo` use
 * for a vendor harness, whose edits ClikCode did not make itself and so has
 * no snapshot of. Pure: text in, text out. */

import type { FileDiff } from './line-diff.js';

/** A file's change as hunks of before and after lines: unchanged context on
 * both sides, `gap` (unchanged lines left out) between hunks. */
export type Hunk = { before: string[]; after: string[] };

export function fileHunks(file: FileDiff): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  for (const line of file.lines) {
    if (line.kind === 'gap') { current = undefined; continue; }
    if (!current) { current = { before: [], after: [] }; hunks.push(current); }
    if (line.kind !== 'added') current.before.push(line.text);
    if (line.kind !== 'removed') current.after.push(line.text);
  }
  return hunks;
}

/** The whole file after the described change, when every hunk is found
 * exactly once in `text` (in order); undefined when any is not. */
export function applyHunks(text: string, hunks: readonly Hunk[]): string | undefined {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let at = 0;
  for (const hunk of hunks) {
    const find = (from: number): number => {
      for (let index = from; index + hunk.before.length <= lines.length; index += 1) {
        if (hunk.before.every((line, offset) => lines[index + offset] === line)) return index;
      }
      return -1;
    };
    const index = hunk.before.length ? find(at) : (hunks.length === 1 && lines.length <= 1 && !lines[0] ? 0 : -1);
    if (index < 0 || (hunk.before.length && find(index + 1) >= 0)) return undefined;
    out.push(...lines.slice(at, index), ...hunk.after);
    at = index + hunk.before.length;
  }
  out.push(...lines.slice(at));
  return out.join(newline);
}

/** Every change a turn made, by file, in the order made: what "Review
 * changes" and "Undo all" act on. Only calls that finished made a change;
 * a file the harness did not name cannot be found again and is left out. */
export function turnChanges(activities: ReadonlyArray<{ kind: string; diff?: FileDiff[] }>): Map<string, FileDiff[]> {
  const files = new Map<string, FileDiff[]>();
  for (const activity of activities) {
    if (activity.kind !== 'tool-done') continue;
    for (const file of activity.diff ?? []) {
      if (!file.path) continue;
      files.set(file.path, [...(files.get(file.path) ?? []), file]);
    }
  }
  return files;
}

/** A file as it was before all of a turn's changes to it, from the file as
 * it is now: each change undone, newest first. `whole` only when every one
 * of them placed cleanly -- the file changed since otherwise, or a change
 * was cut short -- and `created` when the turn made the file. A created
 * file is only `whole` when nothing but what the turn wrote is left in it:
 * deleting it must not take a later edit with it. */
export function unwindChanges(current: string | undefined, changes: readonly FileDiff[]): { before: string; whole: boolean; created: boolean } {
  if (current === undefined) return { before: '', whole: false, created: false };
  let text = current;
  for (let index = changes.length - 1; index >= 0; index -= 1) {
    const change = changes[index]!;
    const undone = change.omitted ? undefined : applyHunks(text, fileHunks(change).map((hunk) => ({ before: hunk.after, after: hunk.before })));
    if (change.change === 'add') {
      return undone !== undefined && !undone.trim() ? { before: '', whole: true, created: true } : { before: text, whole: false, created: false };
    }
    if (undone === undefined) return { before: text, whole: false, created: false };
    text = undone;
  }
  return { before: text, whole: true, created: false };
}
