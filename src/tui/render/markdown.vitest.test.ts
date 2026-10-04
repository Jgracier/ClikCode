import { describe, expect, it } from 'vitest';
import { renderInlineMarkdown, renderInlineMarkdownLive } from './markdown.js';

/** Each step of `text` growing, through the live renderer, against the
 * settled renderer on the same text. */
const streamsAlike = (text: string): void => {
  for (let at = 1; at <= text.length; at += 1) {
    const step = text.slice(0, at);
    expect(renderInlineMarkdownLive(step)).toBe(renderInlineMarkdown(step));
  }
};

describe('renderInlineMarkdownLive', () => {
  it('renders what renderInlineMarkdown does while the text grows', () => {
    streamsAlike('Plain words, then **bold words** and `code` and *em* and [a link](https://example.com) and more words after.');
  });

  it('never settles across a delimiter a later one could pair with', () => {
    streamsAlike('an *open em that closes much later in the text* here');
    streamsAlike('word  \nline break and two  spaces then more');
  });

  it('never settles across marked\'s own bracket and backtick pairing', () => {
    // marked masks `…`, […](…) and <…> over the whole text before matching
    // emphasis, pairing them across what would be the split.
    streamsAlike('_`_[x](y)b aaa`_ and on');
  });

  it('keeps an autolink from hiding an emphasis delimiter', () => {
    streamsAlike('é  )__a@b.coé ![i](p)__***]``]&x_y and the rest');
  });
});
