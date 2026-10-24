import chalk from 'chalk';
import { describe, expect, it } from 'vitest';
import { failureText } from '../../harness/protocol/stderr-line.js';
import { callRow, noteRows } from './tool-rows.js';
import { terminalCellWidth } from './width.js';

const strip = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');
const RED_OPEN = /^\s*\u001b\[[0-9;]*m/;

describe('a note keeps all it says', () => {
  const long = `Error: ${'The current instructions, user requests and required tools do not allow this request to continue. '.repeat(3).trim()}`;

  it('wraps a long note over rows instead of clipping it with an ellipsis like a call label', () => {
    const rows = noteRows(long, 40);
    expect(rows.length).toBeGreaterThan(2);
    expect(strip(rows.join(' ')).replace(/\s+/g, ' ')).toContain('required tools do not allow this request to continue.');
    expect(rows.join('')).not.toContain('…');
    // The call's own row is the one that clips, which is why an error looked cut off.
    expect(strip(callRow(long, 40))).toContain('…');
  });

  it('never runs past the width, and indents like the call', () => {
    for (const width of [24, 40, 80]) {
      for (const row of noteRows(long, width)) {
        expect(row.startsWith('  ')).toBe(true);
        expect(terminalCellWidth(strip(row))).toBeLessThanOrEqual(width);
      }
    }
  });

  it('carries the colour onto every row and closes each one', () => {
    const red = chalk.level ? chalk.red(long) : `\u001b[31m${long}\u001b[39m`;
    const rows = noteRows(`\u001b[31m${long}\u001b[39m`, 40);
    expect(red.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(RED_OPEN.test(row.replace(/^ {2}/, ' ')) || row.includes('\u001b[31m')).toBe(true);
      expect(row.endsWith('\u001b[0m')).toBe(true);
    }
  });

  it('leaves a short or uncoloured note on one plain row', () => {
    expect(noteRows('Saved.', 40)).toEqual(['  Saved.']);
    expect(noteRows('Saved.', 40).join('')).not.toContain('\u001b');
  });

  it('copes with a width that is smaller than a word', () => {
    const rows = noteRows('Error: unauthorized', 4);
    expect(rows.length).toBeGreaterThan(0);
    expect(strip(rows.join('')).replace(/\s+/g, '')).toBe('Error:unauthorized');
  });
});

describe('the error note keeps the whole of a failure', () => {
  it('does not cut a long message to a row or a few hundred characters', () => {
    const message = `Error: ${'a refusal that explains itself at length '.repeat(40)}`;
    expect(failureText(message)).toBe(message.trim());
  });
});
