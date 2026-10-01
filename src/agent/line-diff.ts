/** Small line diff (LCS, capped) for approval previews and activity events. */

/** One line of a file's diff as a row shows it. `line` is its number in
 * the file -- the old file for a removal, the new for the rest -- and only
 * where the numbers are real (a whole file, or a unified diff's hunk
 * headers); an edit of a fragment has none. `gap` marks unchanged lines
 * left out between two hunks. */
export interface DiffLine { kind: 'same' | 'removed' | 'added' | 'gap'; text: string; line?: number }

/** One file of a change, ready to draw. */
export interface FileDiff {
  path?: string;
  change?: 'add' | 'delete' | 'update' | 'move';
  lines: DiffLine[];
  additions: number;
  removals: number;
  /** Diff lines left out to bound `lines`. */
  omitted?: number;
}

/** A diff as an event carries it, from any build: a list of files now, the
 * `{ removed, added }` lists before 2026-10-01 -- which turns already saved,
 * and workers still running an older build, keep sending. Read as the old
 * shape, `.map` threw and the conversation could not be opened. */
export function asFileDiffs(diff: unknown): FileDiff[] | undefined {
  if (Array.isArray(diff)) return diff.filter((file): file is FileDiff => Boolean(file) && Array.isArray((file as FileDiff).lines));
  const legacy = diff as { removed?: unknown; added?: unknown } | undefined;
  if (!legacy || !Array.isArray(legacy.removed) || !Array.isArray(legacy.added)) return undefined;
  const lines = (side: unknown[], kind: 'removed' | 'added'): DiffLine[] => side.map((text) => ({ kind, text: String(text) }));
  return [{ lines: [...lines(legacy.removed, 'removed'), ...lines(legacy.added, 'added')], additions: legacy.added.length, removals: legacy.removed.length }];
}

/** Lines of context kept around each change. */
const DIFF_CONTEXT = 2;
/** Most lines a file's diff carries; rows show fewer. */
const FILE_DIFF_LINE_CAP = 80;

function boundFileDiff(file: FileDiff, cap: number): FileDiff {
  if (file.lines.length <= cap) return file;
  return { ...file, lines: file.lines.slice(0, cap), omitted: (file.omitted ?? 0) + file.lines.length - cap };
}

/** A file's change from its text before and after, as hunks: each change
 * with DIFF_CONTEXT unchanged lines around it, `gap` between hunks.
 * `numbered` only when before/after are the whole file. */
export function fileDiff(before: string, after: string, options: { path?: string; numbered?: boolean; change?: FileDiff['change']; cap?: number } = {}): FileDiff {
  const ops = diffLines(before, after);
  const keep = ops.map(() => false);
  ops.forEach((op, index) => {
    if (op.kind === 'same') return;
    for (let k = Math.max(0, index - DIFF_CONTEXT); k <= Math.min(ops.length - 1, index + DIFF_CONTEXT); k++) keep[k] = true;
  });
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let skipped = false;
  ops.forEach((op, index) => {
    if (op.kind !== 'added') oldLine += 1;
    if (op.kind !== 'removed') newLine += 1;
    if (!keep[index]) { skipped = true; return; }
    if (skipped && lines.length) lines.push({ kind: 'gap', text: '' });
    skipped = false;
    const line = op.kind === 'removed' ? oldLine : newLine;
    lines.push({ kind: op.kind, text: op.line, ...(options.numbered ? { line } : {}) });
  });
  return boundFileDiff({
    ...(options.path ? { path: options.path } : {}), ...(options.change ? { change: options.change } : {}),
    lines, additions: ops.filter((op) => op.kind === 'added').length, removals: ops.filter((op) => op.kind === 'removed').length,
  }, options.cap ?? FILE_DIFF_LINE_CAP);
}

/** The files of a unified diff a vendor already computed (Codex's file
 * changes), numbered from its hunk headers. Text with no hunk header and no
 * +/- lines is a new file's whole content. */
export function unifiedFileDiffs(diff: string, options: { path?: string; change?: FileDiff['change']; cap?: number } = {}): FileDiff[] {
  const cap = options.cap ?? FILE_DIFF_LINE_CAP;
  const text = diff.replace(/\r?\n$/, '');
  if (!/^@@ |^[-+]/m.test(text)) return [fileDiff('', text, { ...options, numbered: true, change: options.change ?? 'add' })];
  const files: FileDiff[] = [];
  let current: FileDiff | undefined;
  let oldLine = 0;
  let newLine = 0;
  const open = (path?: string): FileDiff => {
    const file: FileDiff = { ...(path ?? options.path ? { path: (path ?? options.path)! } : {}), ...(options.change ? { change: options.change } : {}), lines: [], additions: 0, removals: 0 };
    files.push(file);
    return file;
  };
  for (const line of text.split(/\r?\n/)) {
    const git = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (git) { current = open(git[2]); continue; }
    if (/^(?:index |--- |new file mode|deleted file mode|similarity index|rename (?:from|to) )/.test(line)) continue;
    const target = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (target) { if (current && !current.path && target[1] !== '/dev/null') current.path = target[1]; else if (!current) current = open(target[1] === '/dev/null' ? undefined : target[1]); continue; }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      current ??= open();
      if (current.lines.length) current.lines.push({ kind: 'gap', text: '' });
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (line.startsWith('\\')) continue;
    current ??= open();
    if (line.startsWith('-')) { current.lines.push({ kind: 'removed', text: line.slice(1), ...(oldLine ? { line: oldLine } : {}) }); current.removals += 1; if (oldLine) oldLine += 1; }
    else if (line.startsWith('+')) { current.lines.push({ kind: 'added', text: line.slice(1), ...(newLine ? { line: newLine } : {}) }); current.additions += 1; if (newLine) newLine += 1; }
    else { current.lines.push({ kind: 'same', text: line.startsWith(' ') ? line.slice(1) : line, ...(newLine ? { line: newLine } : {}) }); if (oldLine) oldLine += 1; if (newLine) newLine += 1; }
  }
  return files.map((file) => boundFileDiff(file, cap));
}

const LCS_CELL_CAP = 4_000_000;

function splitLines(text: string): string[] {
  if (!text) return [];
  return text.replace(/\r?\n$/, '').split(/\r?\n/);
}

type DiffOp = { kind: 'same' | 'removed' | 'added'; line: string };

export function diffLines(before: string, after: string): DiffOp[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const ops: DiffOp[] = a.slice(0, head).map((line) => ({ kind: 'same' as const, line }));
  if (midA.length * midB.length > LCS_CELL_CAP) {
    // Too large for a quadratic table: report the changed middle wholesale.
    ops.push(...midA.map((line) => ({ kind: 'removed' as const, line })), ...midB.map((line) => ({ kind: 'added' as const, line })));
  } else {
    const n = midA.length;
    const m = midB.length;
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * width + j] = midA[i] === midB[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { ops.push({ kind: 'same', line: midA[i] }); i++; j++; }
      else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) ops.push({ kind: 'removed', line: midA[i++] });
      else ops.push({ kind: 'added', line: midB[j++] });
    }
    while (i < n) ops.push({ kind: 'removed', line: midA[i++] });
    while (j < m) ops.push({ kind: 'added', line: midB[j++] });
  }
  ops.push(...a.slice(a.length - tail).map((line) => ({ kind: 'same' as const, line })));
  return ops;
}

/** An edit as the files it changed -- one here -- which is what an activity
 * event carries. `numbered` when before/after are the whole file. */
export function eventDiff(before: string, after: string, options: { path?: string; numbered?: boolean } = {}): FileDiff[] {
  return [fileDiff(before, after, { ...options, ...(before ? {} : { change: 'add' as const }) })];
}

/** The same from a unified diff a vendor already computed (Codex's file
 * changes), one entry per file it names. */
export function unifiedEventDiff(diff: string, options: { path?: string; change?: FileDiff['change'] } = {}): FileDiff[] {
  return unifiedFileDiffs(diff, options);
}
