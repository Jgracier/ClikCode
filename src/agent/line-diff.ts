/** Small line diff (LCS, capped) for approval previews and activity events. */

interface LineDiff { removed: string[]; added: string[] }

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

function capped(lines: string[], cap: number): string[] {
  return lines.length > cap ? [...lines.slice(0, cap), `… ${lines.length - cap} more line${lines.length - cap === 1 ? '' : 's'}`] : lines;
}

const EVENT_DIFF_LINE_CAP = 12;

/** The `{removed, added}` shape HarnessActivityEvent carries, each side capped
 * with an honest truncation note (see the comment on HarnessActivityEvent.diff). */
export function eventDiff(before: string, after: string, cap = EVENT_DIFF_LINE_CAP): LineDiff {
  const ops = diffLines(before, after);
  return {
    removed: capped(ops.filter((op) => op.kind === 'removed').map((op) => op.line), cap),
    added: capped(ops.filter((op) => op.kind === 'added').map((op) => op.line), cap),
  };
}

/** Unified-style preview with a little context, for approval prompts. */
export function renderDiffPreview(before: string, after: string, options: { context?: number; maxLines?: number } = {}): string {
  const context = options.context ?? 2;
  const maxLines = options.maxLines ?? 60;
  const ops = diffLines(before, after);
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.kind === 'same') return;
    for (let k = Math.max(0, index - context); k <= Math.min(ops.length - 1, index + context); k++) keep[k] = true;
  });
  const out: string[] = [];
  let skipped = false;
  ops.forEach((op, index) => {
    if (!keep[index]) { skipped = true; return; }
    if (skipped && out.length) out.push('  ⋮');
    skipped = false;
    out.push(`${op.kind === 'removed' ? '-' : op.kind === 'added' ? '+' : ' '} ${op.line}`);
  });
  if (!out.length) return '(no changes)';
  return out.length > maxLines ? [...out.slice(0, maxLines), `… ${out.length - maxLines} more diff lines`].join('\n') : out.join('\n');
}
