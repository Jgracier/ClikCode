/** Terminal text made fit for an editor. */

import type { FileDiff } from './protocol';

// CSI (colours, cursor moves), OSC (titles, hyperlinks, clipboard), and the
// lone two-byte escapes; what a terminal renderer emits that a webview would
// show as garbage.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '').replace(CONTROL, '');
}

/** A terminal note's level, from the colour it was painted in: red is a
 * failure, yellow a warning (an account switch, a limit), anything else
 * information. */
export function noticeLevel(text: string): 'info' | 'warning' | 'error' {
  // eslint-disable-next-line no-control-regex
  const colour = /\u001b\[(?:[0-9;]*;)?(3[13]|9[13])m/.exec(text)?.[1];
  return colour === '31' || colour === '91' ? 'error' : colour === '33' || colour === '93' ? 'warning' : 'info';
}

/** How well a path answers what was typed: the file name first, then the
 * path, then the letters in order. Undefined: no match. */
export function mentionScore(relative: string, typed: string): number | undefined {
  const query = typed.toLowerCase();
  if (!query) return 0;
  const path = relative.toLowerCase();
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (name.startsWith(query)) return 0;
  if (name.includes(query)) return 1;
  if (path.includes(query)) return 2;
  let at = 0;
  for (const character of query) {
    at = path.indexOf(character, at);
    if (at < 0) return undefined;
    at += 1;
  }
  return 3;
}

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
 * was cut short -- and `created` when the turn made the file. */
export function unwindChanges(current: string | undefined, changes: readonly FileDiff[]): { before: string; whole: boolean; created: boolean } {
  if (current === undefined) return { before: '', whole: false, created: false };
  let text = current;
  for (let index = changes.length - 1; index >= 0; index -= 1) {
    const change = changes[index]!;
    if (change.change === 'add') return { before: '', whole: true, created: true };
    const undone = change.omitted ? undefined : applyHunks(text, fileHunks(change).map((hunk) => ({ before: hunk.after, after: hunk.before })));
    if (undone === undefined) return { before: text, whole: false, created: false };
    text = undone;
  }
  return { before: text, whole: true, created: false };
}
