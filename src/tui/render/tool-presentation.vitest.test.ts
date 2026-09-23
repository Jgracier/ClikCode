import { describe, expect, it } from 'vitest';
import { TOOL_CATEGORY_STYLE, collapseToolRuns, type ActivityEntry } from './activity-log.js';
import { CATEGORY_PREVIEW_LINES, previewLinesFor } from '../../harness/protocol/activity-events.js';
import { terminalCellWidth } from './width.js';
import type { ToolCategory } from '../../harness/prompter.js';

const CATEGORIES: ToolCategory[] = ['read', 'edit', 'run', 'search', 'fetch'];
const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');

/** An entry as the transcript actually holds one: `lines` is what the row
 * renders to, which is what folding is judged on. */
const toolEntry = (category: ToolCategory, label: string, extra: Record<string, unknown> = {}): ActivityEntry => {
  const event = { kind: 'tool-done', label, category, ...extra } as Record<string, unknown>;
  const shown = [
    ...((event.output as string[] | undefined) ?? []),
    ...((event.diff as { removed: string[]; added: string[] } | undefined)
      ? [...(event.diff as { removed: string[] }).removed, ...(event.diff as { added: string[] }).added] : []),
  ].slice(0, previewLinesFor(category));
  return { anchor: 0, event: event as never, lines: [`  ${label}`, ...shown.map((line) => `    ${line}`)] };
};

describe('tool glyphs', () => {
  it('gives every category its own marker', () => {
    const glyphs = CATEGORIES.map((category) => TOOL_CATEGORY_STYLE[category].glyph);
    expect(new Set(glyphs).size).toBe(CATEGORIES.length);
  });

  it('keeps every glyph single-width so rows stay aligned on a phone', () => {
    // A double-width glyph shifts every row beneath it. Emoji are exactly the
    // trap here, and a narrow terminal is where it shows.
    for (const category of CATEGORIES) {
      expect(terminalCellWidth(TOOL_CATEGORY_STYLE[category].glyph), category).toBe(1);
    }
  });

});

describe('preview budgets', () => {
  it('spends the full budget on an edit and nothing on a read', () => {
    // The edit IS its lines; a read's row already names the file.
    expect(previewLinesFor('edit')).toBeGreaterThan(previewLinesFor('run'));
    expect(previewLinesFor('read')).toBe(0);
  });

  it('never lets an uncategorised tool exceed the widest budget', () => {
    const widest = Math.max(...Object.values(CATEGORY_PREVIEW_LINES));
    expect(previewLinesFor(undefined)).toBeGreaterThanOrEqual(widest);
  });
});

describe('collapseToolRuns', () => {
  it('folds a run of same-kind rows that have nothing to show', () => {
    const folded = collapseToolRuns([
      toolEntry('read', 'a.ts'), toolEntry('read', 'b.ts'), toolEntry('read', 'c.ts'),
    ]);
    expect(folded).toHaveLength(1);
    expect(plain(folded[0]!.lines[0]!)).toContain('read 3 files');
  });

  it('leaves a single call as itself — "1 file" is worse than the filename', () => {
    const folded = collapseToolRuns([toolEntry('read', 'only.ts')]);
    expect(folded).toHaveLength(1);
    expect(plain(folded[0]!.lines[0]!)).toContain('only.ts');
  });

  it('never folds a row that has output or a diff to show', () => {
    const entries = [
      toolEntry('run', 'ls', { output: ['a', 'b'] }),
      toolEntry('run', 'pwd', { output: ['/tmp'] }),
    ];
    expect(collapseToolRuns(entries)).toHaveLength(2);
  });

  it('never folds a failure out of sight', () => {
    const entries = [
      toolEntry('read', 'a.ts'),
      { anchor: 0, event: { kind: 'tool-error', label: 'missing.ts', category: 'read' } as never, lines: ['  missing.ts failed'] },
      toolEntry('read', 'c.ts'),
    ];
    const folded = collapseToolRuns(entries);
    expect(folded).toHaveLength(3);
    expect(plain(folded.map((e) => e.lines.join(' ')).join('\n'))).toContain('missing.ts');
  });

  it('does not fold across different kinds of work', () => {
    const folded = collapseToolRuns([
      toolEntry('read', 'a.ts'), toolEntry('read', 'b.ts'),
      toolEntry('edit', 'c.ts'), toolEntry('edit', 'd.ts'),
    ]);
    expect(folded).toHaveLength(2);
    const text = plain(folded.map((e) => e.lines.join(' ')).join('\n'));
    expect(text).toContain('read 2 files');
    expect(text).toContain('edited 2 files');
  });

  it('does not fold across a message boundary', () => {
    const later = { ...toolEntry('read', 'b.ts'), anchor: 1 };
    expect(collapseToolRuns([toolEntry('read', 'a.ts'), later])).toHaveLength(2);
  });

  it('leaves rows that are not tools alone', () => {
    const note: ActivityEntry = { anchor: 0, lines: ['  a plain note'] };
    expect(collapseToolRuns([note, note])).toHaveLength(2);
  });

  it('turns the six-read turn into one row instead of many', () => {
    const six = Array.from({ length: 6 }, (_, n) => toolEntry('read', `file-${n}.ts`));
    expect(collapseToolRuns(six)).toHaveLength(1);
  });
});
