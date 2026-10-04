import { describe, expect, it } from 'vitest';
import type { ConversationHit, Mention } from './engine.js';
import { MentionBrowser } from './navigate.js';
import { highlightWords, rowOfOccurrence } from '../tui/render/search-focus.js';

const mention = (sessionId: string, messageIndex: number): Mention => ({ sessionId, messageIndex, position: messageIndex, offset: 0, length: 3, exact: true });
const hit = (id: string, count: number): ConversationHit => ({
  conversationId: id, sessionId: id, title: id, provider: null, model: null, updatedAt: '', updatedAtMs: 0,
  mentions: Array.from({ length: count }, (_, index) => mention(id, index)), exactCount: count, score: count,
});

describe('walking mentions', () => {
  it('moves between mentions, stops at the ends, and tabs through conversations in rank order', () => {
    const browser = new MentionBrowser([hit('a', 3), hit('b', 1)]);
    expect(browser.status()).toBe('mention 1 of 3 · chat 1 of 2 · ↑↓ next/previous · tab next chat · esc done');
    expect(browser.previous()).toBe(false);
    expect(browser.next()).toBe(true);
    expect(browser.next()).toBe(true);
    expect(browser.next()).toBe(false);
    expect(browser.current().mention.messageIndex).toBe(2);
    expect(browser.nextChat()).toBe(true);
    expect(browser.current()).toMatchObject({ chat: 1, index: 0, mention: { sessionId: 'b' } });
    expect(browser.nextChat()).toBe(true);
    expect(browser.current()).toMatchObject({ chat: 0, index: 0 });
    // Found by its title alone: a stop with no mention.
    const titled = new MentionBrowser([{ ...hit('named', 0), titleMatch: 'exact' }, hit('b', 1)]);
    expect(titled.current().mention).toBeUndefined();
    expect(titled.status()).toBe('title match, no mentions in it · chat 1 of 2 · ↑↓ next/previous · tab next chat · esc done');
    expect(titled.next()).toBe(false);
    expect(new MentionBrowser([hit('only', 2)]).status()).toBe('mention 1 of 2 · ↑↓ next/previous · tab next chat · esc done');
  });
});

describe('mentions on screen', () => {
  it('inverts every match and keeps the colours around it', () => {
    const row = '\u001b[36mThe Zebra\u001b[39m protocol and zebra';
    const lit = highlightWords(row, ['zebra']);
    expect(lit).toBe('\u001b[36mThe \u001b[7mZebra\u001b[39m\u001b[7m\u001b[27m protocol and \u001b[7mzebra\u001b[27m');
    expect(highlightWords('nothing here', ['zebra'])).toBe('nothing here');
  });

  it('finds the row of the nth occurrence, counting several on one row', () => {
    const rows = ['intro', 'zebra and zebra', 'filler', 'last zebra'];
    expect(rowOfOccurrence(rows, 'zebra', 0)).toBe(1);
    expect(rowOfOccurrence(rows, 'zebra', 1)).toBe(1);
    expect(rowOfOccurrence(rows, 'zebra', 2)).toBe(3);
    expect(rowOfOccurrence(rows, 'zebra', 9)).toBe(3);
    expect(rowOfOccurrence(rows, 'okapi', 0)).toBeUndefined();
  });
});
