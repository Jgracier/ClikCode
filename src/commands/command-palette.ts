/**
 * Matching what was typed against the command palette, and laying the result
 * out for the screen.
 *
 * All pure: a query and a list of entries in, rows out. Kept apart from the
 * prompter because deciding which commands match is not the same job as
 * drawing them, and the matching rules are worth reading on their own.
 */
import type { PickerOption } from './types.js';

/** Palette entries accept three optional fields beyond PickerOption:
 * `argHint` (shown after the command, and kept on screen while its argument is
 * typed), `group` (rendered under a header, after every ungrouped command) and
 * `aliases` (matched like the command itself). */
export type PaletteEntry = PickerOption<string> & { argHint?: string; group?: string; aliases?: readonly string[] };
export const SWITCH_HARNESS_GROUP = 'Switch harness';

const paletteGroup = (entry: PaletteEntry): string | undefined =>
  // One `/<harness>` command per installed harness would otherwise crowd every
  // short query: `/c` is for /clear and /compact, not a list of eight vendors.
  entry.group ?? (/^switch to /i.test(entry.detail ?? '') ? SWITCH_HARNESS_GROUP : undefined);

function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0;
  for (const character of haystack) if (character === needle[index]) index += 1;
  return index >= needle.length;
}

/** Lower is better; undefined is no match. Exact, then prefix, then a match at
 * a word boundary, then anywhere, then fuzzy subsequence -- and only after all
 * of those, a match in the description. */
function paletteRank(entry: PaletteEntry, query: string): number | undefined {
  if (!query) return 0;
  const names = [entry.value, ...(entry.aliases ?? [])].map((name) => name.replace(/^\//, '').toLowerCase());
  let best: number | undefined;
  const consider = (rank: number): void => { if (best === undefined || rank < best) best = rank; };
  for (const [index, name] of names.entries()) {
    const alias = index > 0 ? 0.5 : 0;
    if (name === query) consider(0 + alias);
    else if (name.startsWith(query)) consider(1 + alias);
    else if (new RegExp(`[-_:. ]${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(name)) consider(2 + alias);
    else if (name.includes(query)) consider(3 + alias);
    else if (isSubsequence(query, name)) consider(4 + alias);
  }
  // A one- or two-letter query occurs in nearly every description; matching
  // those would list every command for `/c`.
  if (best === undefined && query.length >= 3 && `${entry.detail ?? ''}`.toLowerCase().includes(query)) consider(5);
  return best;
}

/** The exact command (or alias) the typed text names, case-insensitively. */
export function exactPaletteCommand(value: string, commands: readonly PaletteEntry[]): string | undefined {
  const typed = value.trim().toLowerCase();
  if (!typed.startsWith('/')) return undefined;
  for (const entry of commands) {
    if (entry.value.toLowerCase() === typed) return entry.value;
    if (entry.aliases?.some((alias) => alias.toLowerCase() === typed)) return value.trim();
  }
  return undefined;
}

export function commandPaletteMatches(
  value: string,
  commands: readonly PaletteEntry[],
): readonly PaletteEntry[] {
  if (!value.startsWith('/')) return [];
  const space = value.indexOf(' ');
  if (space !== -1) {
    // Typing an argument: keep just that command up so its hint stays visible.
    const name = value.slice(0, space).toLowerCase();
    const entry = commands.find((candidate) => candidate.value.toLowerCase() === name
      || candidate.aliases?.some((alias) => alias.toLowerCase() === name));
    return entry?.argHint ? [entry] : [];
  }
  const query = value.slice(1).toLowerCase();
  const groupOrder = new Map<string | undefined, number>([[undefined, 0]]);
  const ranked = commands.flatMap((entry, index) => {
    const rank = paletteRank(entry, query);
    if (rank === undefined) return [];
    const group = paletteGroup(entry);
    if (!groupOrder.has(group)) groupOrder.set(group, groupOrder.size);
    return [{ entry: group === entry.group ? entry : { ...entry, group }, rank, index, group: groupOrder.get(group)! }];
  });
  return ranked.sort((left, right) => left.group - right.group || left.rank - right.rank || left.index - right.index)
    .map((item) => item.entry);
}

/** Display rows for a palette window: group headers are rows, but never
 * selectable, and the window is centred on the selected option. */
export function paletteDisplayRows(
  options: readonly PaletteEntry[], selected: number, capacity: number,
): Array<{ header: string } | { option: PaletteEntry; index: number }> {
  const rows: Array<{ header: string } | { option: PaletteEntry; index: number }> = [];
  let group: string | undefined;
  for (const [index, option] of options.entries()) {
    if (option.group !== group) {
      group = option.group;
      if (group) rows.push({ header: group });
    }
    rows.push({ option, index });
  }
  const selectedRow = Math.max(0, rows.findIndex((row) => 'index' in row && row.index === selected));
  let start = Math.max(0, Math.min(selectedRow - Math.floor(capacity / 2), rows.length - capacity));
  // Keep a group's header attached when its first command is at the top.
  if (start > 0 && 'index' in rows[start]! && 'header' in rows[start - 1]! && selectedRow < start + capacity - 1) start -= 1;
  return rows.slice(start, start + capacity);
}

export function composerRightArrowValue(
  value: string, hasPaletteOptions: boolean, opensPalette = false,
): string | undefined {
  return opensPalette && !value && !hasPaletteOptions ? '/' : undefined;
}

export function pickerConfirmsSelection(key: string): boolean {
  return key === '\r' || key === '\n' || key === '\u001b[C';
}

export function pickerDeletesSelection(key: string): boolean {
  return key === '\u001b[3~';
}

