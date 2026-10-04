import { describe, expect, it } from 'vitest';
import { splitIntoBlocks } from './markdown.js';
import { messageRows, renderMessageBlocks } from './message-blocks.js';

describe('messageRows', () => {
  const text = '# Title\n\nA paragraph that is long enough to wrap at a narrow width.\n\n- one\n- two';

  it('is renderMessageBlocks over the sanitized text, laid out once per look', () => {
    const rows = messageRows(text, '·', 30);
    expect(rows).toEqual(renderMessageBlocks(splitIntoBlocks(text), '·', 30));
    expect(messageRows(text, '·', 30)).toBe(rows);
  });

  it('lays out again for another width or marker', () => {
    const rows = messageRows(text, '·', 30);
    expect(messageRows(text, '·', 50)).toEqual(renderMessageBlocks(splitIntoBlocks(text), '·', 50));
    expect(messageRows(text, '›', 30)[0]).toMatch(/^›/);
    expect(messageRows(text, '·', 30)).toEqual(rows);
  });
});
