import { describe, expect, it } from 'vitest';
import { HYPERLINK_CLOSE, closeOpenHyperlink, hyperlinkOpen } from './hyperlinks.js';

describe('closeOpenHyperlink', () => {
  it('closes an OSC 8 hyperlink left open at the end of a row', () => {
    const open = hyperlinkOpen('https://example.com');
    expect(closeOpenHyperlink(`${open}docs`)).toBe(`${open}docs${HYPERLINK_CLOSE}`);
    expect(closeOpenHyperlink(`${open}docs${HYPERLINK_CLOSE}`)).toBe(`${open}docs${HYPERLINK_CLOSE}`);
  });

  it('closes chalk underline left open when a long link label wraps mid-span', () => {
    // wrapWords hard-breaks a long underlined word; without a close, every
    // later row in the chat stayed underlined.
    expect(closeOpenHyperlink('\u001b[4mpartial-link-label')).toBe('\u001b[4mpartial-link-label\u001b[24m');
    expect(closeOpenHyperlink('\u001b[4mlabel\u001b[24m and more')).toBe('\u001b[4mlabel\u001b[24m and more');
    expect(closeOpenHyperlink('\u001b[0mreset already')).toBe('\u001b[0mreset already');
    expect(closeOpenHyperlink('\u001b[1;4mbold underline')).toBe('\u001b[1;4mbold underline\u001b[24m');
  });
});
