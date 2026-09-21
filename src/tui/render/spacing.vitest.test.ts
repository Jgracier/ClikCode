import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import chalk from 'chalk';
import { paintUsageRule, usageRemainingPercent } from './waiting.js';

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

  it('goes green with headroom, yellow when low, red when gone', () => {
    const green = paintUsageRule(40, '80% left');
    const low = paintUsageRule(40, '9% left');
    const gone = paintUsageRule(40, '0% left');
    expect(colourOf(green, '80% left')).toBe('32');
    expect(colourOf(low, '9% left')).toBe('33');
    expect(colourOf(gone, '0% left')).toBe('31');
  });

  it('reads Credits Exhausted as gone even with no percentage in it', () => {
    expect(colourOf(paintUsageRule(40, 'Credits Exhausted'), 'Credits Exhausted')).toBe('31');
  });

  it('leaves the rule itself dim, and says nothing when there is no label', () => {
    expect(plain(paintUsageRule(20, undefined))).toBe('─'.repeat(20));
    expect(paintUsageRule(20, undefined)).toContain('\u001b[2m');
  });

  it('keeps a label it cannot read from shouting', () => {
    // An unparseable figure is not an emergency; it stays furniture-coloured.
    expect(colourOf(paintUsageRule(40, 'tokens: 12k'), 'tokens: 12k')).toBe('2');
  });
});
