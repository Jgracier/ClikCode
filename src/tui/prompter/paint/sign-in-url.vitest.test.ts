import { describe, expect, it } from 'vitest';
import { signInUrlRows } from './bands.js';
import { HYPERLINK_CLOSE, closeOpenHyperlink, hyperlinkOpen } from '../../render/hyperlinks.js';
import { sanitizeTerminalText } from '../../render/text.js';
import { visibleSlice } from '../../render/width.js';

describe('signInUrlRows', () => {
  it('makes every wrapped fragment open the entire consent URL after frame sanitizing', () => {
    const url = 'https://claude.com/cai/oauth/authorize?client_id=example&redirect_uri=http%3A%2F%2Flocalhost%3A49152%2Fcallback&state=abcdef';
    const rows = signInUrlRows(url, 24).map((row) =>
      closeOpenHyperlink(visibleSlice(sanitizeTerminalText(row, { keepSgr: true, singleLine: true }), 27)));
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row).toContain(hyperlinkOpen(url));
      expect(row).toContain(HYPERLINK_CLOSE);
    }
    expect(rows.map((row) => row.replace(/\u001b\]8;[^\u001b]*\u001b\\|\u001b\[[0-9;]*m/g, '').slice(2)).join('')).toBe(url);
  });
});
