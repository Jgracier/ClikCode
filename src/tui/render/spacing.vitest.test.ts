import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import chalk from 'chalk';
import { paintTitleRule, paintUsageRule, usageRemainingPercent } from './waiting.js';

// Colour is off by default with no TTY, which would make every assertion
// below vacuously pass. These tests are about which colour is chosen.
beforeAll(() => { chalk.level = 3; });

const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');
const colourOf = (text: string, needle: string): string =>
  new RegExp(`\\u001b\\[([0-9;]*)m[^\\u001b]*${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).exec(text)?.[1] ?? '';

describe('the composer has room to breathe', () => {
  /**
   * These are layout rules, asserted where they are decided. Each one was
   * reported as "no buffer": the prompt butting against the answer above it,
   * and the rule above the composer sitting on the answer's last line.
   */
  it('opens the resting composer with a clear row', async () => {
    const source = await readFile(new URL('../prompter.ts', import.meta.url), 'utf8');
    const footer = source.slice(source.indexOf('const footer: string[] = [];'));
    const firstPush = footer.slice(0, footer.indexOf('if (noticeRows'));
    expect(firstPush, 'the footer must open with a blank row').toContain("footer.push('')");
  });

  it('gives a change of speaker a bigger break than a change of paragraph', async () => {
    // Every gap was one row -- between messages and between the paragraphs
    // inside them alike -- so a new question read as one more paragraph of
    // the answer above it. Reported four times as "no buffer".
    const source = await readFile(new URL('../prompter.ts', import.meta.url), 'utf8');
    expect(source).toContain("if (message.role === 'user' && index > 0) emit([''])");
  });

  it('does not add that row while a turn is generating', async () => {
    // The generating band already carries a blank, budgeted into the height.
    // A second one there doubles the gap and pushes an answer row off screen.
    const source = await readFile(new URL('../prompter.ts', import.meta.url), 'utf8');
    expect(source).toContain("if (!this.waitingLabel) footer.push('')");
  });
});

describe('usage reads by state, not as furniture', () => {
  it('finds what is left in either wording the harnesses use', () => {
    expect(usageRemainingPercent('5h 42% left · weekly 80% left')).toBe(42);
    expect(usageRemainingPercent('58% used')).toBe(42);
    expect(usageRemainingPercent('$12 credits left')).toBeUndefined();
    expect(usageRemainingPercent(undefined)).toBeUndefined();
  });

  it('stays unpainted until the allowance is actually gone', () => {
    // A figure that is fine needs no colour to say so, and spending one on it
    // only makes the one that matters quieter by comparison. Green-for-healthy
    // was noise; yellow read muddy and fought the user's own theme.
    expect(colourOf(paintUsageRule(40, '80% left'), '80% left')).toBe('');
    expect(colourOf(paintUsageRule(40, '9% left'), '9% left')).toBe('');
    expect(colourOf(paintUsageRule(40, '0% left'), '0% left')).toBe('31');
  });

  it('draws the chat title in the same white as the rules and usage', () => {
    // The title is drawn like the rule it sits on and the composer's text:
    // the terminal's own foreground, no colour of its own.
    expect(colourOf(paintTitleRule(40, 'refactor the parser'), 'refactor the parser')).toBe('');
  });

  it('draws the rule in the terminal\'s own foreground, and says nothing with no label', () => {
    // The frame is white, matching the composer's text between the rules.
    // Dim made it recede so far it read as absent. Unstyled rather than an
    // explicit white, so a light-background theme still gets its foreground.
    expect(paintUsageRule(20, undefined)).toBe('─'.repeat(20));
  });

  it('keeps a label it cannot read from shouting', () => {
    // An unparseable figure is not an emergency: it reads plain, not red.
    expect(colourOf(paintUsageRule(40, 'tokens: 12k'), 'tokens: 12k')).toBe('');
  });
});
