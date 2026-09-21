import { describe, expect, it } from 'vitest';
import { terminalCellWidth } from './markdown';
import { liveConversationLines, rightLabeledRule, waitingSpinnerFrame, waitingSpinnerGlyph } from './waiting';

describe('the waiting band', () => {
  it('packs four animation phases of a logical 4x4 grid into two Braille cells', () => {
    const frames = Array.from({ length: 4 }, (_, frame) => waitingSpinnerFrame(frame));
    expect(new Set(frames.map((frame) => JSON.stringify(frame))).size).toBe(4);
    expect(waitingSpinnerFrame(4)).toEqual(frames[0]);
    expect(frames.every((frame) => frame.flat().length === 16 && frame.flat().filter(Boolean).length === 8)).toBe(true);
    const glyphs = Array.from({ length: 4 }, (_, frame) => waitingSpinnerGlyph(frame));
    expect(new Set(glyphs).size).toBe(4);
    expect(glyphs.every((glyph) => [...glyph].length === 2 && terminalCellWidth(glyph) === 2)).toBe(true);
  });

  it('keeps real live content in the final row on compact mobile viewports', () => {
    expect(liveConversationLines(['user', '', 'streamed response', ''], true)).toEqual([
      'user', '', 'streamed response',
    ]);
    expect(liveConversationLines(['user', '', '· running tool', '', ''], true)).toEqual([
      'user', '', '· running tool',
    ]);
    expect(liveConversationLines(['user', ''], false)).toEqual(['user', '']);
  });

  it('right-aligns usage and title labels without changing the border width', () => {
    expect(rightLabeledRule(40, '5h 88% left · weekly 66% left')).toBe('─'.repeat(10) + ' 5h 88% left · weekly 66% left');
    expect(terminalCellWidth(rightLabeledRule(40, '5h 88% left · weekly 66% left'))).toBe(40);
    expect(rightLabeledRule(30, 'Fix session persistence')).toBe('─'.repeat(6) + ' Fix session persistence');
  });

  it('keeps a visible rule when a label must be truncated', () => {
    const line = rightLabeledRule(12, 'an extremely long title');
    expect(terminalCellWidth(line)).toBe(12);
    expect(line.startsWith('───')).toBe(true);
  });
});
