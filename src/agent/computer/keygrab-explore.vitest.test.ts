import { describe, expect, it } from 'vitest';
import { runKeygrab, type KeyView, type KeygrabPort } from './keygrab.js';
import { exploreForKeys, menuOpeners } from './keygrab-explore.js';

type Ctl = string | { name: string; leaf?: boolean; href?: string; footer?: boolean; nav?: boolean; menu?: boolean };
interface Page { text: string; controls?: Ctl[]; fields?: string[]; password?: boolean; on?: Record<string, string>; keys?: Record<string, string>; key?: boolean; filled?: Record<string, string> }

/** A scripted site: pages by address (a `#menu` suffix is an open menu on the same page), clicks and keys move between them. */
function fakeSite(pages: Record<string, Page>, start: string, extra: { email?: string; press?: boolean } = {}) {
  let at = start;
  const log: string[] = [];
  const captures: Array<string | undefined> = [];
  const pageOf = (url: string): Page => pages[url] ?? { text: '404 page not found' };
  const port: KeygrabPort = {
    open: async url => { log.push(`open ${url}`); at = url; return undefined; },
    look: async (): Promise<KeyView> => { const p = pageOf(at); return { url: at, text: p.text, controls: (p.controls ?? []).map(c => typeof c === 'string' ? { name: c } : c), fields: p.fields ?? [], hasPassword: p.password === true }; },
    click: async name => { log.push(`click ${name}`); const to = pageOf(at).on?.[name]; if (!to) return `Nothing on the page shows "${name}".`; at = to; return undefined; },
    fill: async (name, text) => { log.push(`fill ${name}=${text ?? ''}`); return undefined; },
    login: async () => ({ ok: false, message: 'no saved login' }),
    emailCode: async () => undefined, emailLink: async () => false,
    capture: async target => { captures.push(target); log.push(`capture ${target ?? '(page)'}`); return pageOf(at).key ? { ok: true, message: 'SAVED' } : { ok: false, message: 'Not saved: no key was found' }; },
    ...(extra.press === false ? {} : { press: async (key: string) => { log.push(`press ${key}`); const to = pageOf(at).keys?.[key]; if (to) at = to; return undefined; } }),
    screenshot: async () => undefined,
    profileEmail: async () => extra.email ?? 'user@example.com',
  };
  return { port, log, captures, at: () => at };
}
const run = (site: ReturnType<typeof fakeSite>, over: Partial<Parameters<typeof runKeygrab>[1]> = {}) => runKeygrab(site.port, { id: 'snyk', url: 'https://app.vendor.example/', sleep: async () => undefined, ...over });

const created: Page = { text: 'Your key was created. Copy it now.', controls: ['Done'], key: true };
const keyPage: Page = { text: 'API token\nYou have no API tokens yet.', controls: ['Generate new token', 'Docs'], on: { 'Generate new token': 'https://app.vendor.example/token/made' } };

const APP = 'https://app.vendor.example';
/** Signed-in home: a left nav, an avatar button and nothing that reads like a key page. */
const home = (extra: Partial<Page> = {}): Page => ({
  text: 'Welcome back Projects Reports Dashboard',
  controls: ['Projects', 'Reports', { name: 'Dashboard', nav: true }, { name: 'User menu', menu: true }, { name: 'Sign out' }],
  on: { 'User menu': `${APP}/#menu` },
  ...extra,
});
const menu: Page = {
  text: 'Welcome back Projects Reports Dashboard user@example.com Account settings Billing Sign out',
  controls: [...(home().controls as Ctl[]), { name: 'Account settings', href: `${APP}/settings` }, { name: 'Billing', href: `${APP}/billing` }, { name: 'Cancel plan' }],
  keys: { Escape: `${APP}/` },
};

describe('post-login exploration', () => {
  it('opens the avatar menu, follows Account settings, and finds the API token in the settings navigation', async () => {
    const site = fakeSite({
      [`${APP}/`]: home(), [`${APP}/#menu`]: menu,
      [`${APP}/settings`]: { text: 'Account settings General API Token Billing', controls: [{ name: 'General', nav: true }, { name: 'API Token', nav: true, href: `${APP}/settings/token` }, { name: 'Billing', nav: true, href: `${APP}/billing` }] },
      [`${APP}/settings/token`]: keyPage, [`${APP}/token/made`]: created,
    }, `${APP}/`);
    const view = await site.port.look();
    const explored = await exploreForKeys({
      look: () => site.port.look(), click: async n => !(await site.port.click(n)), open: async u => { await site.port.open(u); return site.port.look(); }, fill: (n, t) => site.port.fill(n, t), press: k => site.port.press!(k),
      isKeyPage: v => v.controls.some(c => typeof c !== 'string' && /Generate new token/.test(c.name)), needsSignIn: () => false, sleep: async () => undefined,
    }, view, { email: 'user@example.com' });
    expect(explored.found?.url).toBe(`${APP}/settings/token`);
    expect(explored.menus[0]).toContain('User menu: Account settings | Billing | Cancel plan');
    expect(explored.visited).toEqual([`${APP}/`, `${APP}/settings`, `${APP}/settings/token`]);
    expect(site.log.join('\n')).not.toMatch(/Sign out|Billing|Cancel/);
  });

  it('keygrab signs in with Google, explores the account menu and captures a key', async () => {
    const site = fakeSite({
      // observed Snyk login texts
      'https://vendor.example/': { text: 'Welcome back Log in with your last used login Continue with Google [email] Data hosting: SNYK-US-01 Log in with a different account | Forget this login', controls: ['Continue with Google gracierdigital@gmail.com Data hosting: SNYK-US-01', 'Log in with a different account', 'Forget this login'], on: { 'Continue with Google gracierdigital@gmail.com Data hosting: SNYK-US-01': 'https://accounts.google.com/chooser' } },
      'https://accounts.google.com/chooser': { text: 'Choose an account', controls: ['user@example.com'], on: { 'user@example.com': `${APP}/` } },
      [`${APP}/`]: home(), [`${APP}/#menu`]: menu,
      [`${APP}/settings`]: { text: 'Account settings', controls: [{ name: 'Auth Token', nav: true, href: `${APP}/settings/token` }] },
      [`${APP}/settings/token`]: keyPage, [`${APP}/token/made`]: created,
    }, 'https://vendor.example/');
    const done = await run(site, { url: 'https://vendor.example/' });
    expect(done).toMatchObject({ ok: true, route: 'google' });
    expect(site.captures.length).toBe(1);
    expect(site.log.some(l => /Sign out|Cancel plan|Billing/.test(l))).toBe(false);
  });

  it('presses a key-ish menu item that has no address while the menu is open', async () => {
    const site = fakeSite({
      [`${APP}/`]: home(), [`${APP}/#menu`]: { ...menu, controls: [...(home().controls as Ctl[]), 'Developer settings', 'Sign out'], on: { 'Developer settings': `${APP}/dev` } },
      [`${APP}/dev`]: keyPage, [`${APP}/token/made`]: created,
    }, `${APP}/`);
    const done = await run(site);
    expect(done.ok).toBe(true);
    expect(site.log.filter(l => l.startsWith('click'))).toContain('click Developer settings');
    expect(site.log.some(l => /Sign out/.test(l))).toBe(false);
  });

  it('uses the site search for "API key" when there is one', async () => {
    const site = fakeSite({
      [`${APP}/`]: { text: 'Home', controls: ['Overview'], fields: ['Search'], keys: { Enter: `${APP}/search?q=api` } },
      [`${APP}/search?q=api`]: { text: 'Results for API key', controls: [{ name: 'API credentials', href: `${APP}/creds` }, { name: 'Delete API key history' }] },
      [`${APP}/creds`]: keyPage, [`${APP}/token/made`]: created,
    }, `${APP}/`);
    // This landing page offers no account menu, so the page counts as signed in only after a sign-in: drive the explorer directly.
    const view = await site.port.look();
    const explored = await exploreForKeys({
      look: () => site.port.look(), click: async n => !(await site.port.click(n)), open: async u => { await site.port.open(u); return site.port.look(); }, fill: (n, t) => site.port.fill(n, t), press: k => site.port.press!(k),
      isKeyPage: v => v.controls.some(c => /Generate new token/.test(c.name)), needsSignIn: () => false, sleep: async () => undefined,
    }, view);
    expect(site.log).toContain('fill Search=API key');
    expect(site.log).toContain('press Enter');
    expect(explored.found?.url).toBe(`${APP}/creds`);
    expect(explored.menus.some(m => m.startsWith('search "API key"'))).toBe(true);
    expect(site.log.join('\n')).not.toContain('Delete');
  });

  it('follows left-nav items through a settings page', async () => {
    const site = fakeSite({
      [`${APP}/`]: { text: 'Home', controls: [{ name: 'Settings', nav: true, href: `${APP}/settings` }, { name: 'Billing', nav: true, href: `${APP}/billing` }, { name: 'Plans & Pricing', nav: true, href: `${APP}/plans` }] },
      [`${APP}/settings`]: { text: 'Settings', controls: [{ name: 'Profile', nav: true, href: `${APP}/profile` }, { name: 'Integrations', nav: true, href: `${APP}/integrations` }] },
      [`${APP}/integrations`]: { text: 'Integrations API access', controls: [{ name: 'Access tokens', href: `${APP}/tokens` }] },
      [`${APP}/tokens`]: keyPage,
    }, `${APP}/`);
    const view = await site.port.look();
    const explored = await exploreForKeys({
      look: () => site.port.look(), click: async n => !(await site.port.click(n)), open: async u => { await site.port.open(u); return site.port.look(); }, fill: (n, t) => site.port.fill(n, t),
      isKeyPage: v => v.controls.some(c => /Generate new token/.test(c.name)), needsSignIn: () => false, sleep: async () => undefined,
    }, view);
    expect(explored.found?.url).toBe(`${APP}/tokens`);
    expect(explored.visited).toContain(`${APP}/integrations`);
    expect(site.log.join('\n')).not.toMatch(/billing|plans/);
  });

  it('stops after the page budget and reports the pages it visited and the menus it read', async () => {
    const pages: Record<string, Page> = { [`${APP}/`]: { text: 'Home', controls: Array.from({ length: 12 }, (_, i) => ({ name: `Settings ${i}`, nav: true, href: `${APP}/s${i}` })) } };
    for (let i = 0; i < 12; i++) pages[`${APP}/s${i}`] = { text: `Settings page ${i}`, controls: [] };
    const site = fakeSite(pages, `${APP}/`);
    const view = await site.port.look();
    const explored = await exploreForKeys({
      look: () => site.port.look(), click: async n => !(await site.port.click(n)), open: async u => { await site.port.open(u); return site.port.look(); }, fill: (n, t) => site.port.fill(n, t),
      isKeyPage: () => false, needsSignIn: () => false, sleep: async () => undefined,
    }, view, { maxPages: 4 });
    expect(explored.found).toBeUndefined();
    expect(explored.visited.length).toBe(5); // the start page and four followed
  });

  it('a keygrab that finds nothing hands over the visited pages and menus', async () => {
    const site = fakeSite({
      'https://vendor.example/': { text: 'Welcome', controls: ['Continue with Google'], on: { 'Continue with Google': 'https://accounts.google.com/chooser' } },
      'https://accounts.google.com/chooser': { text: 'Choose an account', controls: ['user@example.com'], on: { 'user@example.com': `${APP}/` } },
      [`${APP}/`]: home(), [`${APP}/#menu`]: menu,
      [`${APP}/settings`]: { text: 'Account settings General', controls: [{ name: 'General', nav: true }] },
    }, 'https://vendor.example/');
    const done = await run(site, { url: 'https://vendor.example/' });
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.stop.visited).toContain(`${APP}/settings`);
    expect(done.stop.menus?.[0]).toContain('User menu');
    expect(done.stop.signedIn).toBe(true);
  });

  it('a resumed run continues from the current page without opening the start page', async () => {
    const site = fakeSite({
      [`${APP}/`]: home(), [`${APP}/#menu`]: menu,
      [`${APP}/settings`]: { text: 'Account settings', controls: [{ name: 'API Token', nav: true, href: `${APP}/settings/token` }] },
      [`${APP}/settings/token`]: keyPage, [`${APP}/token/made`]: created,
    }, `${APP}/`);
    const done = await run(site, { resume: { visited: [`${APP}/billing`], menus: [], signedIn: true } });
    expect(done.ok).toBe(true);
    expect(site.log[0]).not.toBe(`open ${APP}/`);
  });

  it('opener detection: flagged menus, account names, the signed-in address and initials; never sign out', () => {
    const view: KeyView = { url: APP, text: '', fields: [], hasPassword: false, controls: [{ name: 'JG' }, { name: 'Sign out' }, { name: 'Switch workspace' }, { name: 'More', menu: true }, { name: 'Pricing' }, { name: 'user@example.com' }] };
    expect(menuOpeners(view, 'user@example.com').map(c => c.name)).toEqual(['More', 'JG', 'Switch workspace', 'user@example.com']);
  });
});
