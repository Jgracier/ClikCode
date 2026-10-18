import { describe, expect, it } from 'vitest';
import { arrangeSnapshot, changedLines, collapseOptions, displayUrl, computerWebTool, findInSnapshot } from './computer-web.js';

describe('arrangeSnapshot', () => {
  const longMiddle = Array.from({ length: 900 }, (_, index) => `    - link "Item number ${index} of the long list" [ref=e${100 + index}]`).join('\n');
  const page = [
    '- generic [active] [ref=e1]:',
    '  - banner [ref=e2]:', '    - navigation "Main" [ref=e3]:', '      - link "Models" [ref=e4]',
    '  - main [ref=e5]:', '    - heading "API Keys" [level=1] [ref=e6]', '    - button "Create key" [ref=e7]', longMiddle,
    '  - contentinfo [ref=e8]:', '    - link "Terms" [ref=e9]',
    '  - dialog "Add role" [ref=e10]:', '    - combobox "Role" [ref=e11]', '    - button "Save" [ref=e12]',
  ].join('\n');

  it('puts what is open first, even when it sits at the end of a very long page', () => {
    const out = arrangeSnapshot(page);
    expect(out.startsWith('Open now (dialogs and menus):\n- dialog "Add role" [ref=e10]:\n  - combobox "Role" [ref=e11]\n  - button "Save" [ref=e12]')).toBe(true);
    // The dialog is taken out of the body, not shown twice.
    expect(out.match(/dialog "Add role"/g)).toHaveLength(1);
  });

  it('folds the header and footer, keeps the main area, and trims only the middle of a long page', () => {
    const out = arrangeSnapshot(page.split('\n').filter(line => !/dialog "Add role"|combobox "Role"|button "Save"/.test(line)).join('\n'));
    expect(out).toContain('heading "API Keys"');
    expect(out).toContain('button "Create key" [ref=e7]');
    expect(out).not.toContain('Models');
    expect(out).not.toContain('Terms');
    expect(out).toContain('lines trimmed from the middle');
    expect(out).toContain('Item number 0 ');
    expect(out).toContain('Item number 899 ');
    expect(out).not.toContain('Item number 450 ');
    expect(out).toContain('observe with full: true');
    expect(out.length).toBeLessThan(16_000);
  });

  it('full keeps the header and footer and allows a longer view', () => {
    const out = arrangeSnapshot(page, true);
    expect(out).toContain('Models');
    expect(out).toContain('Terms');
    expect(out).not.toContain('header and footer folded');
  });

  it('folds a long side menu away but keeps a short navigation such as a breadcrumb', () => {
    const menu = Array.from({ length: 40 }, (_, index) => `      - link "Menu item ${index}" [ref=e${200 + index}]`).join('\n');
    const withMenu = ['- generic [ref=e1]:', '  - navigation "Breadcrumb" [ref=e2]:', '    - link "Home" [ref=e3]', '  - navigation "Side" [ref=e4]:', menu, '  - main [ref=e5]:', '    - button "Create key" [ref=e6]'].join('\n');
    const out = arrangeSnapshot(withMenu);
    expect(out).toContain('navigation "Breadcrumb"');
    expect(out).toContain('button "Create key"');
    expect(out).not.toContain('Menu item 0');
    expect(out).toContain('long side menus folded away');
    expect(arrangeSnapshot(withMenu, true)).toContain('Menu item 39');
  });

  it('leaves a short page with no main area exactly as it is', () => {
    const plain = '- generic [ref=e1]:\n  - banner [ref=e2]:\n    - link "Home" [ref=e3]\n  - button "Go" [ref=e4]';
    expect(arrangeSnapshot(plain)).toBe(plain);
  });

  it('opens menus and dropdowns first too', () => {
    const out = arrangeSnapshot('- generic [ref=e1]:\n  - main [ref=e2]:\n    - button "Role" [ref=e3]\n  - listbox [ref=e4]:\n    - option "Compute Admin" [ref=e5]');
    expect(out.startsWith('Open now (dialogs and menus):\n- listbox [ref=e4]:\n  - option "Compute Admin" [ref=e5]')).toBe(true);
  });
});

describe('findInSnapshot', () => {
  const page = ['- generic [ref=e1]:', '  - main [ref=e2]:', '    - dialog "Add role" [ref=e3]:', '      - listbox [ref=e4]:', '        - option "Compute Admin" [ref=e5]', '        - option "Cloud Run Admin" [ref=e6]', '    - button "Other" [ref=e7]'].join('\n');
  it('shows only the lines that mention the words, under the elements that contain them', () => {
    expect(findInSnapshot(page, 'compute admin')).toBe(['- generic [ref=e1]:', '  - main [ref=e2]:', '    - dialog "Add role" [ref=e3]:', '      - listbox [ref=e4]:', '        - option "Compute Admin" [ref=e5]'].join('\n'));
    expect(findInSnapshot(page, 'nothing like this')).toBe('');
  });
});

describe('computer_web labels and plan text', () => {
  const label = (args: Record<string, unknown>): string => computerWebTool.label(args as never);
  it('reads like what is happening, not like the call', () => {
    expect(label({ action: 'open', url: 'https://www.huggingface.co/settings/tokens' })).toBe('Open huggingface.co');
    expect(label({ action: 'click', target: 'e12' })).toBe('Click e12');
    expect(label({ action: 'steps', steps: [{ do: 'click', target: 'e1' }, { do: 'fill', target: 'e2', text: 'x' }] })).toBe('2 steps on the page');
    expect(label({ action: 'capture_secret', secret_name: 'salad/api-key' })).toBe('Capture key as salad/api-key');
    expect(label({ action: 'login' })).toBe('Sign in');
    expect(label({ action: 'wait', text: 'API enabled' })).toBe('Wait for "API enabled"');
  });
});

describe('capture_secret failures say what really happened', () => {
  it('says "Not saved" with the real reason, never a generic "check the browser"', async () => {
    const { setComputerEnabled } = await import('../computer/settings.js');
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const stateDir = await mkdtemp(join(tmpdir(), 'clikcode-web-plan-'));
    try {
      await setComputerEnabled(stateDir, true);
      const result = await computerWebTool.run({ action: 'capture_secret', target: 'e7', send_to: [{ to: 'nowhere' }] } as never, { stateDir } as never);
      expect(result.isError).toBe(true);
      expect(result.output).toMatch(/^Not saved: /);
      expect(result.output).toContain('browser is closed');
      // Nothing was clicked, so no key can have been created, and the output does not claim one was.
      expect(result.output).not.toContain('may already have created');
      expect(result.output).not.toContain('Check the browser and try again');
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });
});

describe('changedLines', () => {
  it('shows only the new lines under their parents, and nothing when nothing changed', () => {
    const before = '- main:\n  - heading "Keys" [ref=e1]\n  - button "Create" [ref=e2]';
    const after = `${before}\n  - alert [ref=e3]:\n    - text: Key created`;
    const changed = changedLines(before, after)!;
    expect(changed.count).toBe(2);
    expect(changed.text).toContain('Key created');
    expect(changed.text).not.toContain('heading "Keys"');
    expect(changedLines(before, before)).toMatchObject({ count: 0 });
  });
  it('gives up when most of the page is different, so a new page is shown whole', () => {
    const before = Array.from({ length: 30 }, (_, i) => `- link "Old ${i}" [ref=e${i}]`).join('\n');
    const after = Array.from({ length: 30 }, (_, i) => `- link "New ${i}" [ref=e${i}]`).join('\n');
    expect(changedLines(before, after)).toBeUndefined();
  });
});

describe('displayUrl', () => {
  it('shortens long or secret query values and fragments, and leaves ordinary addresses alone', () => {
    const long = 'a'.repeat(300);
    expect(displayUrl(`https://signup.example.com/?verify_email=${long}`)).toBe('https://signup.example.com/?verify_email=…');
    expect(displayUrl('https://app.example.com/cb?code=abc123&page=2')).toBe('https://app.example.com/cb?code=…&page=2');
    expect(displayUrl(`https://app.example.com/#access_token=${long}`)).toBe('https://app.example.com/#…');
    expect(displayUrl('https://console.example.com/iam/api-keys')).toBe('https://console.example.com/iam/api-keys');
  });
});

describe('collapseOptions', () => {
  it('keeps the chosen option and the first few of a long list, and counts the rest', () => {
    const options = Array.from({ length: 200 }, (_, i) => `      - option "Country ${i}"${i === 150 ? ' [selected]' : ''}`).join('\n');
    const shown = collapseOptions(`- combobox "Country":\n${options}\n- button "Next"`);
    expect(shown).toContain('option "Country 150" [selected]');
    expect(shown).toContain('option "Country 0"');
    expect(shown).not.toContain('Country 100"');
    expect(shown).toContain('more options; choose one by its text');
    expect(shown).toContain('button "Next"');
    expect(shown.split('\n').length).toBeLessThan(15);
    expect(collapseOptions('- combobox:\n  - option "A"\n  - option "B"')).toContain('option "B"');
  });
});

it('shortens a very long link address in the page view', async () => {
  const { observeComputerPage } = await import('./computer-web.js');
  const long = `https://portal.example.com/#${'a%20b'.repeat(400)}`;
  const page = { url: () => 'https://x.example.com/', locator: () => ({ evaluateAll: async () => [] }), ariaSnapshot: async () => `- link "Go" [ref=e1]:\n  - /url: ${long}`, evaluate: async () => '' } as never;
  const shown = (await observeComputerPage(page, false)).output;
  expect(shown.length).toBeLessThan(400);
  expect(shown).toContain('…');
});

describe('a dialog and the page behind it', () => {
  it('keeps the dialog whole and only the top of the page behind it', () => {
    const behind = Array.from({ length: 300 }, (_, i) => `  - link "Item ${i}" [ref=e${i}]`).join('\n');
    const shown = arrangeSnapshot(`- main:\n${behind}\n- dialog "Create key" [ref=e900]:\n  - button "Create" [ref=e901]`);
    expect(shown).toContain('button "Create" [ref=e901]');
    expect(shown).toContain('more lines of the page behind the dialog');
    expect(shown.split('\n').length).toBeLessThan(60);
    // With no dialog the page is shown as before.
    expect(arrangeSnapshot(`- main:\n${behind}`).split('\n').length).toBeGreaterThan(200);
    // And full still shows everything.
    expect(arrangeSnapshot(`- main:\n${behind}\n- dialog "x" [ref=e900]`, true).split('\n').length).toBeGreaterThan(300);
  });
});
