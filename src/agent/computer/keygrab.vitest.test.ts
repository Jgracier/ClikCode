import { describe, expect, it } from 'vitest';
import { bannerButton, chooserOptions, keygrabWall, runKeygrab, startCandidates, type KeyView, type KeygrabPort } from './keygrab.js';

type Ctl = string | { name: string; leaf?: boolean; href?: string; footer?: boolean };
interface Page { text: string; captchaFrame?: boolean; controls?: Ctl[]; fields?: string[]; password?: boolean; on?: Record<string, string>; key?: boolean }

/** A scripted site: pages by address, a click moves to the page its name maps to, anything unlisted is a 404. */
function fakeSite(pages: Record<string, Page>, start = 'https://vendor.example/', extra: { login?: { ok: boolean; to?: string }; code?: string; email?: string; html?: Record<string, string> } = {}) {
  let at = start;
  const log: string[] = [];
  const captures: Array<string | undefined> = [];
  const filled: Array<[string, string | undefined]> = [];
  const pageOf = (url: string): Page => pages[url] ?? { text: '404 page not found' };
  const port: KeygrabPort = {
    open: async url => { log.push(`open ${url}`); at = url; return undefined; },
    look: async (): Promise<KeyView> => { const p = pageOf(at); return { url: at, text: p.text, controls: (p.controls ?? []).map(c => typeof c === 'string' ? { name: c } : c), fields: p.fields ?? [], hasPassword: p.password === true, ...(p.captchaFrame ? { captchaFrame: true } : {}) }; },
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
    ...(extra.html ? { probe: async (url: string) => { log.push(`probe ${url}`); const final = extra.html![url]; return final ? { html: true, status: 200, url: final } : { html: false, status: 404, url }; } } : {}),
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

describe('keygrab sign-in wording', () => {
  it('takes "Start free with Google" and does not capture a key-shaped word on a marketing page', async () => {
    const site = fakeSite({
      'https://vendor.example/': { text: 'Trusted by 3M users. communication_api_v2_platform_1234 Start free', controls: ['Start free with Google', 'Start free with Email'], on: { 'Start free with Google': 'https://vendor.example/keys' }, key: true },
      'https://vendor.example/keys': keysPage, 'https://vendor.example/keys/new': newKey, 'https://vendor.example/keys/made': madeKey,
    });
    const done = await run(site);
    expect(done).toMatchObject({ ok: true, route: 'google' });
    expect(site.log[1]).toBe('click Start free with Google');
  });
  it('finds a sign-up entry by its accessible name when the visible words are different', async () => {
    const site = fakeSite({
      'https://vendor.example/': { text: 'Developer center. Show all products', controls: ['go to the sign up page in a new tab', 'View all'], on: { 'go to the sign up page in a new tab': 'https://vendor.example/signup' } },
      'https://vendor.example/signup': { text: 'Join', controls: ['Continue with Google'], on: { 'Continue with Google': 'https://vendor.example/keys' } },
      'https://vendor.example/keys': keysPage, 'https://vendor.example/keys/new': newKey, 'https://vendor.example/keys/made': madeKey,
    });
    expect((await run(site)).ok).toBe(true);
    expect(site.log).not.toContain('click View all');
  });
  it('signs in through a "Sign up for free" entry on a page that has no provider buttons', async () => {
    const site = fakeSite({
      'https://vendor.example/': { text: 'Welcome to the developer center', controls: ['Sign up for free'], on: { 'Sign up for free': 'https://vendor.example/signup' } },
      'https://vendor.example/signup': { text: 'Join', controls: ['Continue with GitHub'], on: { 'Continue with GitHub': 'https://vendor.example/keys' } },
      'https://vendor.example/keys': keysPage, 'https://vendor.example/keys/new': newKey, 'https://vendor.example/keys/made': madeKey,
    });
    expect(await run(site)).toMatchObject({ ok: true, route: 'github' });
  });
});

describe('keygrab and slow pages', () => {
  it("looks again at a page that says it is loading", async () => {
    const site = fakeSite({ 'https://vendor.example/': { text: 'Hi', controls: ['Continue with Google'], on: { 'Continue with Google': 'https://vendor.example/keys' } }, 'https://vendor.example/keys': keysPage, 'https://vendor.example/keys/new': newKey, 'https://vendor.example/keys/made': madeKey });
    let looks = 0;
    const real = site.port.look;
    site.port.look = async () => { const v = await real(); return v.url.endsWith('/keys') && looks++ < 2 ? { url: v.url, text: "Just a minute, we're loading…", controls: [], fields: [], hasPassword: false } : v; };
    expect((await run(site)).ok).toBe(true);
    expect(looks).toBeGreaterThan(2);
  });
});

describe('keygrab email route on a log-in page', () => {
  it('goes to the sign-up link before filling when it lands on a log-in form it has no login for', async () => {
    const site = fakeSite({
      'https://vendor.example/': { text: 'Log in', fields: ['E-mail', 'Password'], password: true, controls: ['Log in', 'Sign up here'], on: { 'Sign up here': 'https://vendor.example/signup' } },
      'https://vendor.example/signup': { text: 'Create your account', fields: ['E-mail', 'Password'], password: true, controls: ['Create account', 'Login here'], on: { 'Create account': 'https://vendor.example/keys' } },
      'https://vendor.example/keys': keysPage, 'https://vendor.example/keys/new': newKey, 'https://vendor.example/keys/made': madeKey,
    });
    expect(await run(site)).toMatchObject({ ok: true, route: 'email' });
    const at = (needle: string) => site.log.indexOf(needle);
    expect(at('click Sign up here')).toBeGreaterThan(-1);
    expect(at('click Sign up here')).toBeLessThan(at('fill E-mail'));
  });
});

describe('keygrab email route when the form is not accepted', () => {
  it('stops with the form on screen instead of wandering', async () => {
    const form: Page = { text: 'Choose your plan. Please select a plan.', fields: ['Work email', 'Password'], password: true, controls: ['Create account'], on: { 'Create account': 'https://vendor.example/' } };
    const site = fakeSite({ 'https://vendor.example/': form });
    const done = await run(site);
    expect(done.ok).toBe(false);
    expect(site.log.some(l => l.startsWith('open ') && l !== 'open https://vendor.example/')).toBe(false);
    if (!done.ok) expect(done.stop.pageText).toContain('Please select a plan');
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
    ['Performing security verification. This website uses a security service to protect against malicious bots.', 'captcha'],
    ['Verify your phone number. We texted a code to your phone', 'sms'],
    ['Enter your credit card number to start. Card number', 'payment'],
    ['Identity verification required: upload a government-issued ID', 'identity'],
    ['Thanks for signing up. You are on the waitlist', 'vendor-contact'],
    ['Gmail addresses are not allowed. Use a work email.', 'decision'],
    ['Error 1016 Origin DNS error: Cloudflare is currently unable to resolve your requested domain', 'retire'],
    ['This domain is for sale. Make an offer. Buy now', 'retire'],
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

describe('keygrab on a retired vendor and a Google chooser', () => {
  it('asks to retire the connector when the vendor says it was retired and there is no key page', async () => {
    const site = fakeSite({ 'https://vendor.example/': { text: 'Visual Studio App Center was retired on March 31, 2025. Welcome.', controls: ['Learn more'] } });
    const done = await run(site);
    expect(done.ok === false && done.stop.human).toMatchObject({ kind: 'retire', reasonCode: 'vendor-retired' });
  });
  it("clicks the address when a Google chooser row's name runs the person and the address together", async () => {
    const site = fakeSite({
      'https://vendor.example/': { text: 'Hi', controls: ['Google'], on: { Google: 'https://accounts.google.com/chooser' } },
      'https://accounts.google.com/chooser': { text: 'Choose an account', controls: ['Justin Gracieruser@example.com', 'user@example.com'], on: { 'user@example.com': 'https://vendor.example/keys' } },
      'https://vendor.example/keys': keysPage, 'https://vendor.example/keys/new': newKey, 'https://vendor.example/keys/made': madeKey,
    });
    expect((await run(site)).ok).toBe(true);
    expect(site.log).not.toContain('click Justin Gracieruser@example.com');
  });
});

describe('keygrab starting on an API host', () => {
  it('starts from the parent domain when the address is a bare API endpoint', async () => {
    const site = fakeSite({
      'https://api.vendor.example/': { text: '{"code":2004,"message":"Not Authorized"}' },
      'https://vendor.example/': { text: 'API keys', controls: ['Create new secret key'], on: { 'Create new secret key': 'https://vendor.example/keys/new' } },
      'https://vendor.example/keys/new': newKey, 'https://vendor.example/keys/made': madeKey,
    }, 'https://api.vendor.example/');
    expect((await run(site, { url: 'https://api.vendor.example/' })).ok).toBe(true);
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

const keyFlow: Record<string, Page> = { 'https://vendor.example/keys': keysPage, 'https://vendor.example/keys/new': newKey, 'https://vendor.example/keys/made': madeKey };

describe('keygrab cookie banners', () => {
  it('prefers the least permissive button', () => {
    expect(bannerButton({ text: 'We use cookies', controls: [{ name: 'Accept all' }, { name: 'Reject all' }, { name: 'Settings' }] })?.name).toBe('Reject all');
    expect(bannerButton({ text: 'We use cookies', controls: [{ name: 'Accept all' }, { name: 'Necessary only' }] })?.name).toBe('Necessary only');
    expect(bannerButton({ text: 'Cookie consent', controls: [{ name: 'Allow all' }, { name: 'Got it' }] })?.name).toBe('Allow all');
    expect(bannerButton({ text: 'Privacy policy updated', controls: [{ name: 'OK' }] })).toBeUndefined();
    expect(bannerButton({ text: 'Welcome', controls: [{ name: 'Accept all' }] })).toBeUndefined();
    expect(bannerButton({ text: 'We use cookies', controls: [{ name: 'Accept', leaf: true }] })).toBeUndefined();
  });

  it('dismisses a consent banner before looking for sign-in', async () => {
    const site = fakeSite({
      'https://vendor.example/': { text: 'We value your privacy. We use cookies. Welcome', controls: ['Accept all', 'Settings', 'Continue with Google'], on: { 'Accept all': 'https://vendor.example/home', 'Continue with Google': 'https://accounts.google.com/chooser' } },
      'https://vendor.example/home': { text: 'Welcome', controls: ['Continue with Google', 'Docs'], on: { 'Continue with Google': 'https://accounts.google.com/chooser' } },
      'https://accounts.google.com/chooser': { text: 'Choose an account', controls: ['user@example.com'], on: { 'user@example.com': 'https://vendor.example/keys' } },
      ...keyFlow,
    });
    expect(await run(site)).toMatchObject({ ok: true, route: 'google' });
    expect(site.log.indexOf('click Accept all')).toBeGreaterThan(-1);
    expect(site.log.indexOf('click Accept all')).toBeLessThan(site.log.indexOf('click Continue with Google'));
  });
});

describe('keygrab product chooser (Musixmatch)', () => {
  const chooser = "Discover Contribute Search Are you an artist? Make the most of your lyrics with Musixmatch Pro! Let's getin Choose the product and sign in. Community Contribute on your favourite songs Pro Distribute the lyrics of your verified artists Platform Musixmatch Pro Catalog Intelligence Royalties Sentinel";
  const controls: Ctl[] = ['Discover', 'Contribute', 'Search', { name: 'Community Contribute on your favourite songs', leaf: true }, { name: 'Pro Distribute the lyrics of your verified artists', leaf: true }, { name: 'Platform Musixmatch Pro Catalog Intelligence Royalties Sentinel', leaf: true }, 'API', 'Documentation', 'Pricing'];
  it('finds the options and picks the community one', () => {
    const found = chooserOptions({ text: chooser, controls: controls.map(c => typeof c === 'string' ? { name: c } : c) });
    expect(found?.options.length).toBeGreaterThanOrEqual(3);
    expect(found?.pick?.name).toMatch(/^Community/);
  });
  it('signs in from the chooser through the community option, then Google', async () => {
    const site = fakeSite({
      'https://vendor.example/': { text: 'Music lyrics. We use cookies.', controls: ['Accept all', 'Login', 'API'], on: { 'Accept all': 'https://vendor.example/', Login: 'https://vendor.example/sign-in' } },
      'https://vendor.example/sign-in': { text: chooser, controls, on: { 'Community Contribute on your favourite songs': 'https://vendor.example/sign-in/community' } },
      'https://vendor.example/sign-in/community': { text: 'Sign in', controls: ['Continue with Google'], on: { 'Continue with Google': 'https://accounts.google.com/chooser' } },
      'https://accounts.google.com/chooser': { text: 'Choose an account', controls: ['user@example.com'], on: { 'user@example.com': 'https://vendor.example/keys' } },
      ...keyFlow,
    });
    expect(await run(site)).toMatchObject({ ok: true, route: 'google' });
    expect(site.log).toContain('click Community Contribute on your favourite songs');
  });
  it('hands off with the options when none is the API one', async () => {
    const site = fakeSite({
      'https://vendor.example/': { text: 'Choose the product and sign in. Alpha thing Beta thing', controls: ['Login', { name: 'Alpha thing', leaf: true }, { name: 'Beta thing', leaf: true }], on: { Login: 'https://vendor.example/' } },
    });
    const done = await run(site);
    expect(done.ok).toBe(false);
    if (!done.ok) { expect(done.stop.kind).toBe('choice'); expect(done.stop.message).toContain('Alpha thing'); }
  });
});

describe('keygrab provider buttons that are plain boxes', () => {
  it('takes "Continue with Google" even when the page marks it as no button (Musixmatch auth)', async () => {
    const site = fakeSite({
      'https://vendor.example/': { text: 'Welcome to Musixmatch Continue with Google Continue with Facebook Continue with email By continuing, you accept our Terms and Conditions and Privacy Policy.', controls: [{ name: 'Continue with Google', leaf: true }, { name: 'Continue with Facebook', leaf: true }, { name: 'Continue with email', leaf: true }, 'Terms and Conditions', 'Privacy Policy.'], on: { 'Continue with Google': 'https://accounts.google.com/chooser' } },
      'https://accounts.google.com/chooser': { text: 'Choose an account', controls: ['user@example.com'], on: { 'user@example.com': 'https://vendor.example/keys' } },
      ...keyFlow,
    });
    expect(await run(site)).toMatchObject({ ok: true, route: 'google' });
  });
});

describe('keygrab provider screens', () => {
  it('presses Continue on the consent screen that shows the chosen address again', async () => {
    const site = fakeSite({
      'https://vendor.example/': { text: 'Sign in', controls: ['Continue with Google'], on: { 'Continue with Google': 'https://accounts.google.com/chooser' } },
      'https://accounts.google.com/chooser': { text: 'Choose an account to continue to Vendor user@example.com', controls: ['Justin Gracieruser@example.com'], on: { 'user@example.com': 'https://accounts.google.com/consent' } },
      'https://accounts.google.com/consent': { text: 'Sign in to Vendor user@example.com selected. Continue', controls: [{ name: 'user@example.com', leaf: true }, 'Cancel', 'Continue'], on: { 'user@example.com': 'https://accounts.google.com/consent', Continue: 'https://vendor.example/keys' } },
      ...keyFlow,
    });
    expect(await run(site)).toMatchObject({ ok: true, route: 'google' });
    expect(site.log.filter(l => l === 'click user@example.com').length).toBe(1);
  });
  it('stops instead of carrying on when it never leaves the provider', async () => {
    const site = fakeSite({
      'https://vendor.example/': { text: 'Sign in', controls: ['Continue with Google'], on: { 'Continue with Google': 'https://accounts.google.com/chooser' } },
      'https://accounts.google.com/chooser': { text: 'Something unusual appears here', controls: ['Whatever'] },
    });
    const done = await run(site);
    expect(done.ok).toBe(false);
  });
});

describe('keygrab key page from the front page', () => {
  it('goes back to the vendor front page for its API link when sign-in ends in an account area', async () => {
    const site = fakeSite({
      'https://vendor.example/': { text: 'Lyrics', controls: ['Sign in with Google', 'API', 'Documentation'], on: { 'Sign in with Google': 'https://accounts.google.com/chooser', API: 'https://developer.vendor.example/' } },
      'https://accounts.google.com/chooser': { text: 'Choose an account', controls: ['user@example.com'], on: { 'user@example.com': 'https://account.vendor.example/' } },
      'https://account.vendor.example/': { text: 'Account Personal info', controls: ['Personal info'] },
      'https://developer.vendor.example/': { text: 'Developer portal', controls: ['Sign in with Google'], on: { 'Sign in with Google': 'https://accounts.google.com/chooser2' } },
      'https://accounts.google.com/chooser2': { text: 'Choose an account', controls: ['user@example.com'], on: { 'user@example.com': 'https://developer.vendor.example/keys' } },
      'https://developer.vendor.example/keys': keysPage, 'https://vendor.example/keys/new': newKey, 'https://vendor.example/keys/made': madeKey,
    });
    const done = await run(site);
    expect(done.ok).toBe(true);
    expect(site.log).toContain('click API');
  });
});

describe('keygrab walls need strong evidence', () => {
  const aiception = "AIception Artificial Intelligence for Humankind LET'S TALK PROTOTYPE YOURSELF About Lessons learned: 1. KYC Remediation is challenging. 2. OCR is not a silver bullet. Discover how AI can streamline document verification, reduce customs delays, and improve compliance";
  const shipstation = 'ShipStation Talk to an Expert Your business is growing. We keep it moving. Start Shipping Now No credit card required Cancel anytime Pricing Plans Starter Growth Pro';
  const wordApi = 'Word Associations API Pricing Basic $10 Pro $50 Frequently Asked Questions Is my payment information secure? All payments are processed by PayPal. Our web site has no access to credit cards data. When will I be billed? PayPal will charge your credit card upon subscription to our API plan.';
  it.each([['aiception', aiception], ['shipengine (shipstation)', shipstation], ['wordassociations', wordApi], ['a tier table', 'Free $0 Starter $19 Business $99 Enterprise Contact us LET\'S TALK']])('%s is not a wall', (_name, text) => {
    expect(keygrabWall(text)).toBeUndefined();
  });
  it('still stops on a card form, identity verification, a real challenge and a captcha frame', () => {
    expect(keygrabWall('Add a card to continue. Card number Expiry date CVC')?.kind).toBe('payment');
    expect(keygrabWall('Payment', false, false, { fields: ['Card number'] })?.kind).toBe('payment');
    expect(keygrabWall('Please verify your identity: upload a photo of your passport')?.kind).toBe('identity');
    expect(keygrabWall('Business verification is required before you can create keys')?.kind).toBe('identity');
    expect(keygrabWall('Please verify you are human to continue')?.kind).toBe('captcha');
    expect(keygrabWall('Sign in', false, false, { captchaFrame: true })?.kind).toBe('captcha');
    expect(keygrabWall("Let's confirm you are human. Complete the security check before continuing. Begin")?.kind).toBe('captcha');
  });
  it('does not call "protected by reCAPTCHA" a captcha', () => {
    expect(keygrabWall('Sign in. This site is protected by reCAPTCHA and the Google Privacy Policy apply.')).toBeUndefined();
  });
  it('continues from a pricing landing page to sign-up and the key', async () => {
    const site = fakeSite({
      'https://vendor.example/': { text: wordApi, controls: ['Pricing', 'Sign up'], on: { 'Sign up': 'https://vendor.example/signup' } },
      'https://vendor.example/signup': { text: 'Create your account', controls: ['Continue with Google'], on: { 'Continue with Google': 'https://accounts.google.com/chooser' } },
      'https://accounts.google.com/chooser': { text: 'Choose an account', controls: ['user@example.com'], on: { 'user@example.com': 'https://vendor.example/keys' } },
      ...keyFlow,
    });
    expect(await run(site)).toMatchObject({ ok: true });
  });
});

describe('keygrab sign-in targets', () => {
  it('ignores a footer or social GitHub link and uses the header sign-in', async () => {
    const site = fakeSite({
      'https://vendor.example/': { text: 'Scanner', controls: [{ name: 'Log in' }, { name: 'github', href: 'https://github.com/vendor', footer: true }, { name: 'Google', href: 'https://google.com/search', footer: true }], on: { 'Log in': 'https://vendor.example/login', github: 'https://github.com/vendor' } },
      'https://vendor.example/login': { text: 'Sign in', controls: ['Sign in with Google'], on: { 'Sign in with Google': 'https://accounts.google.com/chooser' } },
      'https://accounts.google.com/chooser': { text: 'Choose an account', controls: ['user@example.com'], on: { 'user@example.com': 'https://vendor.example/keys' } },
      ...keyFlow,
    });
    expect(await run(site)).toMatchObject({ ok: true, route: 'google' });
    expect(site.log).not.toContain('click github');
  });
  it('tries the next candidate when a click goes nowhere', async () => {
    const site = fakeSite({
      'https://vendor.example/': { text: 'Sign in', controls: ['Sign in with Google', 'Continue with GitHub'], on: { 'Sign in with Google': 'https://vendor.example/', 'Continue with GitHub': 'https://github.com/login/oauth/authorize' } },
      'https://github.com/login/oauth/authorize': { text: 'Authorize app', controls: ['Authorize acme-app'], on: { 'Authorize acme-app': 'https://vendor.example/keys' } },
      ...keyFlow,
    });
    expect(await run(site)).toMatchObject({ ok: true, route: 'github' });
    expect(site.log.indexOf('click Sign in with Google')).toBeLessThan(site.log.indexOf('click Continue with GitHub'));
  });
  it('ranks "Continue with Google" above a bare provider name', async () => {
    const site = fakeSite({
      'https://vendor.example/': { text: 'Sign in', controls: ['Google', 'Continue with Google'], on: { Google: 'https://vendor.example/', 'Continue with Google': 'https://accounts.google.com/chooser' } },
      'https://accounts.google.com/chooser': { text: 'Choose an account', controls: ['user@example.com'], on: { 'user@example.com': 'https://vendor.example/keys' } },
      ...keyFlow,
    });
    await run(site);
    expect(site.log.filter(l => l.startsWith('click'))[0]).toBe('click Continue with Google');
  });
});

describe('keygrab start page', () => {
  it('builds candidates from the vendor domain', () => {
    const c = startCandidates('https://tracking.api.here.com', ['https://developer.here.com/']);
    expect(c.slice(0, 2)).toEqual(['https://tracking.api.here.com', 'https://developer.here.com/']);
    expect(c).toEqual(expect.arrayContaining(['https://api.here.com/', 'https://here.com/', 'https://developers.here.com/', 'https://here.com/signup', 'https://here.com/login', 'https://here.com/account', 'https://here.com/developers']));
  });
  it('skips an API host that answers JSON and starts at a real page, following redirects', async () => {
    const site = fakeSite({
      'https://developer.here.com/': { text: 'Developer', controls: ['Sign in with Google'], on: { 'Sign in with Google': 'https://accounts.google.com/chooser' } },
      'https://accounts.google.com/chooser': { text: 'Choose an account', controls: ['user@example.com'], on: { 'user@example.com': 'https://developer.here.com/keys' } },
      'https://developer.here.com/keys': keysPage, 'https://vendor.example/keys/new': newKey, 'https://vendor.example/keys/made': madeKey,
    }, 'https://tracking.api.here.com/', { html: { 'https://developer.here.com/': 'https://developer.here.com/' } });
    const done = await run(site, { url: 'https://tracking.api.here.com/' });
    expect(done.ok).toBe(true);
    expect(site.log).toContain('open https://developer.here.com/');
    expect(site.log).not.toContain('open https://tracking.api.here.com/');
  });
  it('opens the final address after a redirect to the real app domain', async () => {
    const site = fakeSite({
      'https://www.shipstation.com/': { text: 'ShipStation No credit card required', controls: ['Sign in with Google'], on: { 'Sign in with Google': 'https://accounts.google.com/chooser' } },
      'https://accounts.google.com/chooser': { text: 'Choose an account', controls: ['user@example.com'], on: { 'user@example.com': 'https://www.shipstation.com/keys' } },
      'https://www.shipstation.com/keys': keysPage, 'https://vendor.example/keys/new': newKey, 'https://vendor.example/keys/made': madeKey,
    }, 'https://shipengine.com/', { html: { 'https://shipengine.com/': 'https://www.shipstation.com/' } });
    await run(site, { url: 'https://shipengine.com/' });
    expect(site.log).toContain('open https://www.shipstation.com/');
  });
});

describe('keygrab action count', () => {
  it('reports how many browser actions it took when it stops', async () => {
    const site = fakeSite({ 'https://vendor.example/': { text: 'Hello there, this is a plain page with nothing to press.', controls: ['Home'] } });
    const done = await run(site);
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.stop.actions).toBe(done.steps);
  });
});
