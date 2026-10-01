/** For tests: the lines a file diff removed and added, across all its files. */
import type { FileDiff } from './line-diff.js';

export function changed(files: readonly FileDiff[] | undefined): { removed: string[]; added: string[] } {
  const lines = (files ?? []).flatMap((file) => file.lines);
  return { removed: lines.filter((line) => line.kind === 'removed').map((line) => line.text), added: lines.filter((line) => line.kind === 'added').map((line) => line.text) };
}
