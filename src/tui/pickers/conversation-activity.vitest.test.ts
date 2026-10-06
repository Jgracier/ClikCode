import { describe, expect, it } from 'vitest';
import { conversationLabel, subagentOptions } from './conversation-activity';
import { turnStalled } from '../../harness/protocol/turn-pace';

const NOW = Date.parse('2026-09-29T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const strip = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');

describe('a stalled turn', () => {
  it('has not stalled while it is still doing things, however long it has run', () => {
    expect(turnStalled(30_000)).toBe(false);
    expect(turnStalled(Number.NaN)).toBe(false);
  });

  it('has stalled after three quiet minutes', () => {
    expect(turnStalled(3 * 60_000)).toBe(true);
    expect(turnStalled(16 * 60_000)).toBe(true);
  });
});

describe('a conversation row in the terminal', () => {
  it('starts with a three-cell glyph column: spinner, dot or blank', () => {
    expect(strip(conversationLabel({ label: 'Fix it', activity: 'working' }, 0))).toMatch(/^[⠀-⣿]{2} Fix it$/);
    expect(strip(conversationLabel({ label: 'Fix it', activity: 'needs-you' }, 0))).toBe('●  Fix it');
    expect(strip(conversationLabel({ label: 'Fix it' }, 0))).toBe('   Fix it');
  });
});

describe('a working conversation\'s agents', () => {
  const pending = {
    prompt: 'go', startedAt: ago(10 * 60_000), updatedAt: ago(20 * 60_000), outputStarted: true,
    subagents: [
      { id: 'a', label: 'Agent(Explore)', startedAt: ago(5 * 60_000), step: 'Read(src/a.ts)', stepAt: ago(10_000) },
      { id: 'b', label: 'Agent(Review)', startedAt: ago(60_000) },
    ],
  };

  it('lists each sub-agent with its step, and each opens the conversation', () => {
    const rows = subagentOptions(pending, 'conversation-1', NOW);
    expect(rows.map((row) => [strip(row.label), strip(row.detail ?? ''), row.value])).toEqual([
      ['● Agent(Explore)', '· Read(src/a.ts) · 5m', 'conversation-1'],
      ['● Agent(Review)', '· starting · 1m', 'conversation-1'],
    ]);
  });
});
