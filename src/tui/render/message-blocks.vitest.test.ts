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

describe('a notice ClikCode sent the model', () => {
  it('is drawn muted under its own label, wrapped, never with the user marker', async () => {
    const { noticeRows } = await import('./message-blocks.js');
    const { isClikCodeNotice } = await import('../../session/clikcode-notice.js');
    const plainRows = noticeRows('[ClikCode] Background work you started was stopped: a newer build. Check whether it finished.', 30)
      .map((row) => row.replace(/\u001b\[[0-9;]*m/g, ''));
    expect(plainRows[0]).toBe('✦ ClikCode notice');
    expect(plainRows.slice(1).every((row) => row.startsWith('  ') && row.length <= 30)).toBe(true);
    expect(plainRows.join(' ')).not.toContain('[ClikCode]');
    expect(plainRows.join(' ').replace(/\s+/g, ' ')).toContain('Background work you started was stopped');
    expect(isClikCodeNotice('[background shell 3 exited (code 0)] npm test\nok')).toBe(true);
    expect(isClikCodeNotice('[background shell 3 was stopped: idle] npm run dev\n(no unread output)')).toBe(true);
    expect(isClikCodeNotice('please check [ClikCode] later')).toBe(false);
    expect(isClikCodeNotice('[background] what is a shell?')).toBe(false);
  });
});
