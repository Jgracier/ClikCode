import { describe, expect, it } from 'vitest';
import { displayStatusText } from './computer.js';

describe('clikcode computer display', () => {
  const linux = { platform: 'linux' as const, desktop: true, headless: false };

  it('says hidden is the default and how to watch anyway', () => {
    const text = displayStatusText({ ...linux, display: 'hidden', running: undefined });
    expect(text).toMatch(/^Display is hidden \(the default\)/);
    expect(text).toContain('`show` action');
    expect(text).toContain('clikcode computer display visible');
    expect(text).toContain('No browser is running: the setting applies when the next one starts.');
  });

  it('leaves a running browser alone and says how to restart it', () => {
    const text = displayStatusText({ ...linux, display: 'visible', running: 'hidden' });
    expect(text).toMatch(/^Display is visible/);
    expect(text).toContain('The browser running now is hidden and was left as it is');
    expect(text).toContain('applies the next time the browser starts');
    expect(text).toContain('`clikcode computer off`');
    expect(text).toContain('`clikcode computer on`');
    expect(displayStatusText({ ...linux, display: 'hidden', running: 'visible' })).toContain('The browser running now is visible and was left as it is');
  });

  it('says only what is so when the running browser already matches', () => {
    const text = displayStatusText({ ...linux, display: 'visible', running: 'visible' });
    expect(text).toContain('The browser running now is visible.');
    expect(text).not.toContain('clikcode computer off');
  });

  it('says when visible cannot happen from here: no desktop, or headless', () => {
    expect(displayStatusText({ ...linux, desktop: false, display: 'visible', running: undefined })).toContain('No desktop session can be seen from this terminal');
    expect(displayStatusText({ ...linux, desktop: false, display: 'hidden', running: undefined })).not.toContain('No desktop session');
    expect(displayStatusText({ ...linux, headless: true, display: 'visible', running: 'headless' })).toContain('Headless is on');
  });

  it('says the setting is for Linux on the other systems', () => {
    const text = displayStatusText({ platform: 'darwin', desktop: true, headless: false, display: 'hidden', running: 'visible' });
    expect(text).toContain('On macOS and Windows the browser window is always on the desktop');
    expect(text).toContain('The browser running now is visible.');
  });
});
