import { describe, expect, it } from 'vitest';
import { windowMayShowBrowser } from './sensitive-fields.js';

describe('which desktop windows could show the ClikCode browser', () => {
  it('compares the window owner pid with the browser process ids, the same on every OS', () => {
    // Chrome reports its browser, renderer and GPU processes; a window listing names the owning process id.
    const browser = [4100, 4155, 4160];
    expect(windowMayShowBrowser(browser, 4100)).toBe(true);
    expect(windowMayShowBrowser(browser, 4160)).toBe(true);
    expect(windowMayShowBrowser(browser, 777)).toBe(false);
  });

  it('guards the window when it cannot be told apart', () => {
    expect(windowMayShowBrowser(undefined, 777)).toBe(true);
    expect(windowMayShowBrowser([4100], undefined)).toBe(true);
    expect(windowMayShowBrowser([], 777)).toBe(false);
  });
});
