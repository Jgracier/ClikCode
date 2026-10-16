import { describe, expect, it } from 'vitest';
import { computerWebTool, observeComputerPage, webAddress } from './computer-web.js';
import type { Page } from 'playwright-core';

describe('ClikCode browser boundary', () => {
  it('accepts websites and rejects local files and URL credentials', () => {
    expect(webAddress('https://example.com/work')).toBe('https://example.com/work');
    expect(() => webAddress('file:///etc/passwd')).toThrow('HTTP or HTTPS');
    expect(() => webAddress('https://name:secret@example.com')).toThrow('without credentials');
  });

  it('requires approval before observing browser state or changing it', () => {
    expect(computerWebTool.class).toBe('exec');
  });

  it('does not expose a filled password field to a model', async () => {
    const fake = {
      url: () => 'https://example.com/login?token=private',
      locator: () => ({ count: async () => 1 }),
      ariaSnapshot: () => { throw new Error('snapshot would reveal the password'); },
      screenshot: () => { throw new Error('capture would reveal the page'); },
    } as unknown as Page;
    expect(await observeComputerPage(fake, true)).toEqual({
      output: 'Page: https://example.com\n\nSign-in form detected. Browser contents are hidden until the user completes sign-in.',
    });
  });
});
