import { describe, expect, it } from 'vitest';
import { conversationLabel } from './conversation-activity';
import { turnStalled } from '../../harness/protocol/turn-pace';

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
