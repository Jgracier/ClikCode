import { describe, expect, it } from 'vitest';
import { conversationLabel } from './conversation-activity';

const strip = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');

describe('a conversation row in the terminal', () => {
  it('starts with a three-cell glyph column: spinner, dot or blank', () => {
    expect(strip(conversationLabel({ label: 'Fix it', activity: 'working' }, 0))).toMatch(/^[⠀-⣿]{2} Fix it$/);
    expect(strip(conversationLabel({ label: 'Fix it', activity: 'needs-you' }, 0))).toBe('●  Fix it');
    expect(strip(conversationLabel({ label: 'Fix it' }, 0))).toBe('   Fix it');
  });
});
