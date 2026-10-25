import { describe, expect, it } from 'vitest';
import { keygrabWall, runKeygrab, type KeyView, type KeygrabPort } from './keygrab.js';

interface Page { text: string; controls?: string[]; fields?: string[]; password?: boolean; on?: Record<string, string>; key?: boolean }

/** A scripted site: pages by address, a click moves to the page its name maps to, anything unlisted is a 404. */
function fakeSite(pages: Record<string, Page>, start = 'https://vendor.example/', extra: { login?: { ok: boolean; to?: string }; code?: string; email?: string } = {}) {
  let at = start;
  const log: string[] = [];
  const captures: Array<string | undefined> = [];
  const filled: Array<[string, string | undefined]> = [];
  const pageOf = (url: string): Page => pages[url] ?? { text: '404 page not found' };
  const port: KeygrabPort = {
    open: async url => { log.push(`open ${url}`); at = url; return undefined; },
    look: async (): Promise<KeyView> => { const p = pageOf(at); return { url: at, text: p.text, controls: (p.controls ?? []).map(name => ({ name })), fields: p.fields ?? [], hasPassword: p.password === true }; },
    click: async name => {
      log.push(`click ${name}`);
      const to = pageOf(at).on?.[name];
      if (!to) return `Nothing on the page shows "${name}".`;
      at = to;
      return undefined;
    },
    fill: async (name, text) => { log.push(`fill ${name}`); filled.push([name, text]); return undefined; },
    login: async () => { log.push('login'); const l = extra.login ?? { ok: false }; if (l.ok && l.to) at = l.to; return { ok: l.ok, message: l.ok ? 'Signed in.' : 'no saved login' }; },
    emailCode: async () => { log.push('emailCode'); return extra.code; },
    emailLink: async () => { log.push('emailLink'); return false; },
    capture: async target => { captures.push(target); log.push(`capture ${target ?? '(page)'}`); return pageOf(at).key ? { ok: true, message: 'SAVED' } : { ok: false, message: 'Not saved: no key was found' }; },
    screenshot: async () => '/tmp/shots/vendor.png',
    profileEmail: async () => extra.email ?? 'user@example.com',
  };
  return { port, log, captures, filled, at: () => at };
}
const run = (site: ReturnType<typeof fakeSite>, over: Partial<Parameters<typeof runKeygrab>[1]> = {}) => runKeygrab(site.port, { id: 'acme', url: 'https://vendor.example/', sleep: async () => undefined, ...over });

const keysPage: Page = { text: 'API keys\nYou have no API keys yet.', controls: ['Create new secret key', 'Docs'], on: { 'Create new secret key': 'https://vendor.example/keys/new' } };
const newKey: Page = { text: 'Create key', fields: ['Name'], controls: ['Cancel', 'Create secret key'], on: { 'Create secret key': 'https://vendor.example/keys/made' } };
const madeKey: Page = { text: 'Your key was created. Save it now.', controls: ['Done'], key: true };

describe('keygrab sign-in order', () => {
  it('signs in with Google first, finds the API keys link, names the key ClikDeploy and captures it unseen', async () => {
    const site = fakeSite({
      'https://vendor.example/': { text: 'Welcome', controls: ['Continue with Google', 'Continue with GitHub', 'Log in'], on: { 'Continue with Google': 'https://accounts.google.com/chooser', 'Continue with GitHub': 'https://github.com/login' } },
      'https://accounts.google.com/chooser': { text: 'Choose an account', controls: ['user@example.com'], on: { 'user@example.com': 'https://accounts.google.com/consent' } },
      'https://accounts.google.com/consent': { text: 'Sign in to Acme', controls: ['Continue'], on: { Continue: 'https://vendor.example/dashboard' } },
      'https://vendor.example/dashboard': { text: 'Dashboard', controls: ['Overview', 'API Keys', 'Billing'], on: { 'API Keys': 'https://vendor.example/keys' } },
      'https://vendor.example/keys': keysPage, 'https://vendor.example/keys/new': newKey, 'https://vendor.example/keys/made': madeKey,
    });
    const done = await run(site);
    expect(done).toMatchObject({ ok: true, route: 'google' });
    expect(site.log).not.toContain('login');
    expect(site.log.some(l => l.includes('github'))).toBe(false);
    expect(site.filled).toContainEqual(['Name', 'ClikDeploy']);
    expect(site.captures).toEqual([undefined]);
  });

  it('uses GitHub when Google is not offered, signing in to GitHub with the saved login', async () => {
    const pages: Record<string, Page> = {
      'https://github.com/login/oauth/authorize': { text: 'Authorize Acme', controls: ['Authorize acme-app'], on: { 'Authorize acme-app': 'https://vendor.example/developers' } },
      'https://vendor.example/developers': keysPage, 'https://vendor.example/keys/new': newKey, 'https://vendor.example/keys/made': madeKey,
    };
    const site2 = fakeSite({ 'https://vendor.example/': { text: 'Welcome', controls: ['Continue with GitHub'], on: { 'Continue with GitHub': 'https://github.com/login' } }, 'https://github.com/login': { text: 'Sign in to GitHub', password: true, fields: ['Password'] }, ...pages }, 'https://vendor.example/', { login: { ok: true, to: 'https://github.com/login/oauth/authorize' } });
    const done = await run(site2);
    expect(done).toMatchObject({ ok: true, route: 'github' });
    expect(site2.log).toContain('login');
  });

  it('falls back to the profile email: sign-up form filled from the profile, then the emailed code', async () => {
    const site = fakeSite({
      'https://vendor.example/': { text: 'Create your account', fields: ['Email', 'Password'], password: true, controls: ['Sign up'], on: { 'Sign up': 'https://vendor.example/verify' } },
      'https://vendor.example/verify': { text: 'Check your email. Enter the verification code we sent.', fields: ['Code'], controls: ['Verify'], on: { Verify: 'https://vendor.example/keys' } },
      'https://vendor.example/keys': keysPage, 'https://vendor.example/keys/new': newKey, 'https://vendor.example/keys/made': madeKey,
    }, 'https://vendor.example/', { code: '482913' });
    const done = await run(site);
    expect(done).toMatchObject({ ok: true, route: 'email' });
    expect(site.filled).toContainEqual(['Email', undefined]);
    expect(site.filled).toContainEqual(['Password', undefined]);
    expect(site.filled).toContainEqual(['Code', '482913']);
  });
});

describe('keygrab finding the key page', () => {
  it('tries the common paths when no menu item reads like an API page', async () => {
    const site = fakeSite({
      'https://vendor.example/': { text: 'Dashboard', controls: ['Home', 'Settings'] },
      'https://vendor.example/developers': keysPage, 'https://vendor.example/keys/new': newKey, 'https://vendor.example/keys/made': madeKey,
    });
    const done = await run(site);
    expect(done.ok).toBe(true);
    const opened = site.log.filter(l => l.startsWith('open '));
    expect(opened.slice(0, 4)).toEqual(['open https://vendor.example/', 'open https://vendor.example/settings/api-keys', 'open https://vendor.example/account/api', 'open https://vendor.example/dashboard/api']);
    expect(opened).toContain('open https://vendor.example/developers');
    expect(opened).not.toContain('open https://vendor.example/keys');
  });

  it('takes the link whose text matches API keys before the common paths', async () => {
    const site = fakeSite({
      'https://vendor.example/': { text: 'Home', controls: ['Pricing', 'API credentials'], on: { 'API credentials': 'https://vendor.example/anything' } },
      'https://vendor.example/anything': keysPage, 'https://vendor.example/keys/new': newKey, 'https://vendor.example/keys/made': madeKey,
    });
    expect((await run(site)).ok).toBe(true);
    expect(site.log.filter(l => l.startsWith('open '))).toEqual(['open https://vendor.example/']);
  });

  it('accepts a plain name dialog, and captures with no dialog too', async () => {
    const site = fakeSite({
      'https://vendor.example/': { text: 'API keys page', controls: ['Generate API key'], on: { 'Generate API key': 'https://vendor.example/shown' } },
      'https://vendor.example/shown': { text: 'Here is your key', controls: ['Close'], key: true },
    });
    expect((await run(site)).ok).toBe(true);
    expect(site.filled).toEqual([]);
  });

  it('reveals a key that is hidden behind Show', async () => {
    const site = fakeSite({ 'https://vendor.example/': { text: 'Your API key is hidden', controls: ['Show', 'Revoke key'], key: true } });
    const done = await run(site);
    expect(done.ok).toBe(true);
    expect(site.log).not.toContain('click Revoke key');
  });

  it('never presses delete, revoke, rotate or regenerate', async () => {
    const site = fakeSite({ 'https://vendor.example/': { text: 'API keys: one key exists', controls: ['Regenerate API key', 'Delete key', 'Revoke token'] } });
    const done = await run(site);
    expect(done.ok).toBe(false);
    expect(site.log.some(l => /Regenerate|Delete|Revoke/.test(l))).toBe(false);
  });
});

describe('keygrab walls', () => {
  const wall = async (text: string, extra: Partial<Page> = {}) => {
    const site = fakeSite({ 'https://vendor.example/': { text, controls: ['Continue'], ...extra } });
    return run(site);
  };
  it.each([
    ['Please verify you are human. Complete the captcha', 'captcha'],
    ['Verify your phone number. We texted a code to your phone', 'sms'],
    ['Enter your credit card number to start. Card number', 'payment'],
    ['Identity verification required: upload a government-issued ID', 'identity'],
    ['Thanks for signing up. You are on the waitlist', 'vendor-contact'],
    ['Gmail addresses are not allowed. Use a work email.', 'decision'],
  ])('stops with a human step for %s', async (text, kind) => {
    const done = await wall(text);
    expect(done.ok).toBe(false);
    if (!done.ok) {
      expect(done.stop.human).toMatchObject({ kind, url: 'https://vendor.example/' });
      expect(done.stop.human!.instructions).toMatch(/nothing was paid|does not bypass/);
    }
  });
  it('does not mistake a billing link on a page with a Create key button for a payment wall', () => {
    expect(keygrabWall('Billing\nCard number on file ends 4242', true)).toBeUndefined();
    expect(keygrabWall('Billing\nCard number', false)?.kind).toBe('payment');
  });
  it('does not read pricing words on a landing page that offers sign-in as a payment wall', async () => {
    const site = fakeSite({
      'https://vendor.example/': { text: 'Plans and pricing. Credit card required for paid plans. Start your free trial', controls: ['Log in', 'Sign up'], on: { 'Sign up': 'https://vendor.example/signup' } },
      'https://vendor.example/signup': { text: 'Create account', controls: ['Continue with Google'], on: { 'Continue with Google': 'https://vendor.example/keys' } },
      'https://vendor.example/keys': keysPage, 'https://vendor.example/keys/new': newKey, 'https://vendor.example/keys/made': madeKey,
    });
    expect((await run(site)).ok).toBe(true);
  });
  it('skips a friendly not-found page when trying the common paths', async () => {
    const site = fakeSite({
      'https://vendor.example/': { text: 'Dashboard', controls: ['Home'] },
      'https://vendor.example/settings/api-keys': { text: "Oops... Sorry we couldn't find what you were looking for.", controls: ['Go to home'] },
      'https://vendor.example/developers': keysPage, 'https://vendor.example/keys/new': newKey, 'https://vendor.example/keys/made': madeKey,
    });
    expect((await run(site)).ok).toBe(true);
  });
  it('stops on a wall found after signing in, not only on the first page', async () => {
    const site = fakeSite({
      'https://vendor.example/': { text: 'Hi', controls: ['Continue with Google'], on: { 'Continue with Google': 'https://vendor.example/next' } },
      'https://vendor.example/next': { text: 'Almost there: enter your credit card number', controls: ['Pay'] },
    });
    const done = await run(site);
    expect(done.ok === false && done.stop.human?.kind).toBe('payment');
  });
});

describe('keygrab on a page it does not know', () => {
  it('stops with the page text (about 300 characters), the buttons and a screenshot', async () => {
    const site = fakeSite({ 'https://vendor.example/': { text: 'Pick a data center for your organisation. '.repeat(30), controls: ['EU', 'US'] } });
    const done = await run(site);
    expect(done.ok).toBe(false);
    if (!done.ok) {
      expect(done.stop.kind).toBe('unknown');
      expect(done.stop.pageText.length).toBeLessThanOrEqual(300);
      expect(done.stop.controls).toEqual(['EU', 'US']);
      expect(done.stop.screenshot).toBe('/tmp/shots/vendor.png');
      expect(done.stop.human).toBeUndefined();
      expect(done.stop.trail!.length).toBeGreaterThan(0);
    }
  });
  it('stops at its step budget instead of wandering', async () => {
    const site = fakeSite({ 'https://vendor.example/': { text: 'Nothing here', controls: ['Home'] } });
    const done = await run(site, { maxSteps: 3 });
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.stop.message).toMatch(/step budget/);
  });
  it('says a key may exist when capture fails after Create', async () => {
    const site = fakeSite({
      'https://vendor.example/': keysPage, 'https://vendor.example/keys/new': newKey, 'https://vendor.example/keys/made': { text: 'Created', controls: ['Done'] },
    });
    const done = await run(site);
    expect(done.ok === false && done.stop.message).toMatch(/may have been created/);
  });
});
