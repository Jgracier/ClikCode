import { describe, expect, it } from 'vitest';
import { approvedFile, inOrder, withSignInHints, verificationCode, arrangeSnapshot, changedLines, collapseOptions, displayUrl, computerWebTool, findInSnapshot } from './computer-web.js';

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

describe('browser_use labels and plan text', () => {
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

describe('profile ask_fields and custom: an agent asks for the details a task needs', () => {
  const withState = async (body: (stateDir: string) => Promise<void>): Promise<void> => {
    const { setComputerEnabled } = await import('../computer/settings.js');
    const { lockCredentialVault } = await import('../computer/credential-vault.js');
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const stateDir = await mkdtemp(join(tmpdir(), 'clikcode-web-profile-'));
    try { await setComputerEnabled(stateDir, true); await body(stateDir); } finally { lockCredentialVault(stateDir); await rm(stateDir, { recursive: true, force: true }); }
  };

  it('forget_login removes a site\'s saved login from the vault and answers with a count, never the account', async () => {
    await withState(async (stateDir) => {
      const { saveLoginFields, savedLoginsForSite } = await import('../computer/credential-vault.js');
      await saveLoginFields(stateDir, 'https://login.wordnik.com/', { username: 'private@example.com', password: 'hunter2-saved' });
      const none = await computerWebTool.run({ action: 'forget_login', target: 'wordnik.com', label: 'someone-else' } as never, { stateDir } as never);
      expect(none.output).toContain('No saved login');
      const done = await computerWebTool.run({ action: 'forget_login', target: 'login.wordnik.com', label: 'private@example.com' } as never, { stateDir } as never);
      expect(done.output).toContain('Removed 1 saved login');
      expect(done.output).not.toContain('private@example.com');
      expect(await savedLoginsForSite(stateDir, 'https://login.wordnik.com/')).toEqual([]);
      const missing = await computerWebTool.run({ action: 'forget_login' } as never, { stateDir } as never);
      expect(missing.isError).toBe(true);
    });
  });

  it('add_login asks one private form (website, email, password), saves the login, and never echoes the password', async () => {
    await withState(async (stateDir) => {
      const { savedLoginsForSite } = await import('../computer/credential-vault.js');
      const asked: Array<{ key: string; kind: string; current?: string }[]> = [];
      const requestPrivateLogin = async (_site: string, fields: readonly { key: string; kind: string; current?: string }[]) => { asked.push([...fields]); return { website: 'accounts.google.com', email: 'me@example.com', password: 'pw-secret-1' }; };
      const done = await computerWebTool.run({ action: 'add_login' } as never, { stateDir, requestPrivateLogin } as never);
      expect(done.output).toContain('Saved the login');
      expect(asked[0]!.map(field => field.key)).toEqual(['website', 'email', 'password']);
      expect(asked[0]![0]!.current).toBe('https://accounts.google.com/');
      expect(done.output).toContain('accounts.google.com');
      expect(done.output).not.toContain('pw-secret-1');
      expect((await savedLoginsForSite(stateDir, 'https://accounts.google.com/')).map(login => login.label)).toEqual(['me@example.com']);
      const closed = await computerWebTool.run({ action: 'add_login' } as never, { stateDir, requestPrivateLogin: async () => undefined } as never);
      expect(closed.isError).toBe(true);
    });
  });

  it('asks once, privately, with what is kept offered back, and saves the answers as a named profile', async () => {
    await withState(async (stateDir) => {
      const asked: Array<{ site: string; fields: Array<{ key: string; label: string; required: boolean; current?: string }> }> = [];
      const ctx = { stateDir, requestPrivateLogin: async (site: string, fields: Array<{ key: string; label: string; required: boolean; current?: string }>) => {
        asked.push({ site, fields });
        return { app_name: 'ClikDeploy', privacy_policy_url: 'https://clikdeploy.com/legal/privacy', app_description: '' };
      } } as never;
      const specs = [
        { key: 'app_name', label: 'App name', match: ['app name', 'application name'] },
        { key: 'privacy_policy_url', label: 'Privacy policy URL' },
        { key: 'app_description', label: 'Short description', optional: true },
      ];
      const first = await computerWebTool.run({ action: 'profile', label: 'ClikDeploy OAuth apps', ask_fields: specs } as never, ctx);
      expect(first.isError).toBeFalsy();
      expect(first.output).toContain('ClikDeploy OAuth apps: app_name=ClikDeploy, privacy_policy_url=https://clikdeploy.com/legal/privacy');
      // Optional and left empty: not saved. One prompt, showing the title of the profile prompt.
      expect(first.output).not.toContain('app_description');
      expect(asked).toHaveLength(1);
      expect(asked[0]!.site).toBe('https://profile.clikcode');
      expect(asked[0]!.fields.map(field => [field.key, field.required])).toEqual([['app_name', true], ['privacy_policy_url', true], ['app_description', false]]);
      // Asking again shows what is kept as the current value.
      await computerWebTool.run({ action: 'profile', label: 'ClikDeploy OAuth apps', ask_fields: specs } as never, ctx);
      expect(asked[1]!.fields.find(field => field.key === 'app_name')!.current).toBe('ClikDeploy');
    });
  });

  it('saves details the agent already knows with custom, and says why a secret or a bad name is refused', async () => {
    await withState(async (stateDir) => {
      const ctx = { stateDir } as never;
      const saved = await computerWebTool.run({ action: 'profile', label: 'ClikDeploy OAuth apps', custom: { redirect_uri: { label: 'Redirect URI', value: 'https://clikdeploy.com/api/connectors/oauth/callback', match: ['redirect uri', 'callback url'] } } } as never, ctx);
      expect(saved.output).toContain('redirect_uri=https://clikdeploy.com/api/connectors/oauth/callback');
      const secret = await computerWebTool.run({ action: 'profile', custom: { client_secret: { value: 'Zq8xW3vLm9PaRt5YcN2bKd7HgF4jS6eU' } } } as never, ctx);
      expect(secret.isError).toBe(true);
      expect(secret.output).toContain('looks like a key');
      const badName = await computerWebTool.run({ action: 'profile', ask_fields: [{ key: 'App Name', label: 'x' }] } as never, { stateDir, requestPrivateLogin: async () => ({}) } as never);
      expect(badName.isError).toBe(true);
      expect(badName.output).toContain('lower-case');
    });
  });
});

describe('verificationCode', () => {
  it('reads the code a verification email names, and refuses a guess when several numbers compete', () => {
    expect(verificationCode('Your HubSpot verification code is 482913. It expires in 10 minutes.')).toBe('482913');
    expect(verificationCode('Verification code: A7K9QX')).toBe('A7K9QX');
    expect(verificationCode('Use 551234 to sign in to Slack')).toBe('551234');
    expect(verificationCode('Order 123456 and ticket 654321 are ready')).toBeUndefined();
    expect(verificationCode('Welcome aboard, nothing to enter')).toBeUndefined();
  });
});

describe('withSignInHints', () => {
  const stub = (url: string, text = ''): never => ({ url: () => url, evaluate: async () => text }) as never;
  it('names the profile\'s sign-in account at a Google account chooser and flags a consent screen that asks for more than a sign-in', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { saveProfile } = await import('../computer/profiles.js');
    const dir = await mkdtemp(join(tmpdir(), 'clikcode-hints-'));
    try {
      const ok = { output: 'Page: x' };
      expect((await withSignInHints(ok, stub('https://accounts.google.com/v3/signin/accountchooser?x=1'), dir)).output).toContain('no sso_email');
      await saveProfile(dir, { fields: { sso_email: 'me@example.com' } });
      expect((await withSignInHints(ok, stub('https://accounts.google.com/v3/signin/accountchooser?x=1'), dir)).output).toContain('click target "me@example.com"');
      expect((await withSignInHints(ok, stub('https://accounts.google.com/signin/oauth/v3/consent', 'See, edit, share, and permanently delete all the calendars'), dir)).output).toContain('Decline it with Cancel');
      expect((await withSignInHints(ok, stub('https://accounts.google.com/signin/oauth/id', 'Name and profile picture'), dir)).output).toBe('Page: x');
      expect(await withSignInHints(ok, stub('https://example.com/'), dir)).toBe(ok);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('inOrder', () => {
  it('runs calls made together one after another, and keeps going after one throws', async () => {
    const log: string[] = [];
    const slow = inOrder('chat', async () => { log.push('a start'); await new Promise(resolve => setTimeout(resolve, 30)); log.push('a end'); throw new Error('boom'); });
    const fast = inOrder('chat', async () => { log.push('b'); return 'b'; });
    await expect(slow).rejects.toThrow('boom');
    expect(await fast).toBe('b');
    expect(log).toEqual(['a start', 'a end', 'b']);
  });
});

describe('approvedFile', () => {
  it('lets an upload send only a file the user saved in the profile under a _file name', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { saveProfile } = await import('../computer/profiles.js');
    const dir = await mkdtemp(join(tmpdir(), 'clikcode-upload-'));
    const ctx = { stateDir: dir } as never;
    const files = join(process.cwd(), 'uploads-test-readable');
    await (await import('node:fs/promises')).mkdir(files, { recursive: true });
    try {
      const logo = join(files, 'logo.png');
      await writeFile(logo, 'x');
      await saveProfile(dir, { fields: {}, custom: { logo_file: { value: logo }, notes: { value: logo } } });
      expect(await approvedFile(ctx, 'logo_file')).toBe(logo);
      await expect(approvedFile(ctx, 'notes')).rejects.toThrow('ending _file');
      await expect(approvedFile(ctx, '/etc/passwd')).rejects.toThrow('ending _file');
      await expect(approvedFile(ctx, 'other_file')).rejects.toThrow('no other_file');
      await saveProfile(dir, { fields: {}, custom: { gone_file: { value: join(files, 'missing.png') } } });
      await expect(approvedFile(ctx, 'gone_file')).rejects.toThrow('not on this computer');
    } finally { await rm(dir, { recursive: true, force: true }); await rm(files, { recursive: true, force: true }); }
  });
});

describe('splitCodeFields', () => {
  const box = (label: string, over: Record<string, unknown> = {}) => ({ password: false, maxlength: 1, label, placeholder: '', hint: { autocomplete: '', text: label }, ...over });
  it('finds a code split over single-character boxes that calls itself a code', async () => {
    const { splitCodeFields } = await import('./computer-web.js');
    const six = Array.from({ length: 6 }, (_, index) => box(`Digit ${index + 1}`));
    expect(splitCodeFields(six)).toHaveLength(6);
    expect(splitCodeFields(six.map((item, index) => index ? item : box('x', { hint: { autocomplete: 'one-time-code', text: 'x' } })))).toHaveLength(6);
  });
  it('ignores ordinary single boxes, too few or too many, and boxes that are not codes', async () => {
    const { splitCodeFields } = await import('./computer-web.js');
    expect(splitCodeFields(Array.from({ length: 3 }, (_, index) => box(`Digit ${index}`)))).toEqual([]);
    expect(splitCodeFields(Array.from({ length: 12 }, (_, index) => box(`Digit ${index}`)))).toEqual([]);
    expect(splitCodeFields(Array.from({ length: 5 }, (_, index) => box(`Initial ${index}`)))).toEqual([]);
    expect(splitCodeFields(Array.from({ length: 6 }, (_, index) => box(`Digit ${index}`, { maxlength: 6 })))).toEqual([]);
  });
});
