/** What a site may ask the browser for: camera, microphone, location, notifications, clipboard. By default every
 * one is denied, so no permission bubble ever opens (it would block the page waiting for a click nobody makes).
 * The agent can grant or deny per origin with the `permissions` action; a decision lasts while the session that made it runs. */
import { quiet } from '../../runtime/lifecycle-log.js';
import type { CDPSession, Page } from 'playwright-core';
import { sharedState } from './shared-state.js';

/** The names the agent uses, and the browser permissions each stands for. */
const SITE_PERMISSIONS = {
  camera: ['camera'],
  microphone: ['microphone'],
  geolocation: ['geolocation'],
  notifications: ['notifications'],
  clipboard: ['clipboard-read', 'clipboard-write'],
} as const;
type SitePermission = keyof typeof SITE_PERMISSIONS;
const SITE_PERMISSION_NAMES = Object.keys(SITE_PERMISSIONS) as SitePermission[];

type Setting = 'granted' | 'denied';

/** Which Chrome browser context a page is in. Not Playwright's context: a page the browser host opened in an egress context is filed under
 * the shared profile's context over a worker's connection (egress-host.ts), so the target itself is asked. Undefined: the default context. */
const contextIds = sharedState('site-permission-context-ids', () => new WeakMap<Page, Promise<string | undefined>>());
function chromeContextOf(page: Page): Promise<string | undefined> {
  let known = contextIds.get(page);
  if (!known) {
    known = (async () => {
      const session = await page.context().newCDPSession(page);
      try { return ((await session.send('Target.getTargetInfo')) as { targetInfo?: { browserContextId?: string } }).targetInfo?.browserContextId; }
      finally { await session.detach().catch(quiet('agent/computer/site-permissions')); }
    })();
    contextIds.set(page, known);
    known.catch(() => { if (contextIds.get(page) === known) contextIds.delete(page); });
  }
  return known;
}

/** Decisions per Chrome context (by its id, '' for the default one), per origin. */
const states = sharedState('site-permissions', () => new Map<string, Map<string, Map<SitePermission, Setting>>>());
async function forOrigin(page: Page, origin: string): Promise<{ contextId: string | undefined; mine: Map<SitePermission, Setting> }> {
  const contextId = await chromeContextOf(page).catch(() => undefined /* fail-open-ok: no CDP on this page (the default context is used) */);
  const key = contextId ?? '';
  let all = states.get(key);
  if (!all) { all = new Map(); states.set(key, all); }
  let mine = all.get(origin);
  if (!mine) { mine = new Map(); all.set(origin, mine); }
  return { contextId, mine };
}

/** The names in the order the agent gave them, each checked. */
export function parsePermissions(value: unknown): SitePermission[] {
  const list = typeof value === 'string' ? value.split(/[\s,]+/) : Array.isArray(value) ? value : [];
  const names = list.map(item => String(item).trim().toLowerCase()).filter(Boolean);
  const bad = names.filter(name => !(name in SITE_PERMISSIONS));
  if (bad.length) throw new Error(`Unknown permission ${bad.join(', ')}. Use: ${SITE_PERMISSION_NAMES.join(', ')}.`);
  return [...new Set(names as SitePermission[])];
}

export function permissionOrigin(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Permissions are set for a website origin (https://example.com).');
  return parsed.origin;
}

/** Chrome drops what a DevTools session set when that session closes, so one session per browser connection stays open. */
const sessions = sharedState('site-permission-sessions', () => new WeakMap<object, Promise<CDPSession>>());

/** Contexts Chrome does not take an id for (its default one is named by leaving the id out). */
const defaultIds = sharedState('site-permission-default-ids', () => new Set<string>());

async function apply(page: Page, contextId: string | undefined, origin: string, name: SitePermission, setting: Setting): Promise<void> {
  const browser = page.context().browser();
  if (!browser) throw new Error('The browser does not allow permissions to be set here.');
  let opening = sessions.get(browser);
  if (!opening) { opening = browser.newBrowserCDPSession(); sessions.set(browser, opening); opening.catch(() => sessions.delete(browser)); }
  const session = await opening;
  for (const permission of SITE_PERMISSIONS[name]) {
    const params = { permission: { name: permission }, setting, origin };
    if (!contextId || defaultIds.has(contextId)) { await session.send('Browser.setPermission', params); continue; }
    try { await session.send('Browser.setPermission', { ...params, browserContextId: contextId }); }
    catch (error) {
      // The default context's id is not one Browser.setPermission looks up: it is named by leaving the id out.
      if (!/browser context/i.test(error instanceof Error ? error.message : String(error))) throw error;
      defaultIds.add(contextId);
      await session.send('Browser.setPermission', params);
    }
  }
}

/** Grants and denies, for one origin. A permission named in both is denied. */
export async function setSitePermissions(page: Page, origin: string, change: { grant?: readonly SitePermission[]; deny?: readonly SitePermission[] }): Promise<void> {
  const { contextId, mine } = await forOrigin(page, origin);
  const deny = new Set(change.deny ?? []);
  const grant = (change.grant ?? []).filter(name => !deny.has(name));
  // Secure origins only: a site served over plain http cannot be given a camera, location or clipboard.
  for (const name of grant) {
    if (!origin.startsWith('https:') && !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|$)/.test(origin)) throw new Error(`${name} can only be granted to an https site (${origin} is not secure).`);
    await apply(page, contextId, origin, name, 'granted');
    mine.set(name, 'granted');
  }
  for (const name of deny) { await apply(page, contextId, origin, name, 'denied'); mine.set(name, 'denied'); }
}

/** Before a page of this origin is opened: everything not yet decided is denied. Best effort. */
export async function denyByDefault(page: Page, origin: string): Promise<void> {
  const { mine } = await forOrigin(page, origin);
  const undecided = SITE_PERMISSION_NAMES.filter(name => !mine.has(name));
  if (!undecided.length) return;
  await setSitePermissions(page, origin, { deny: undecided }).catch(quiet('agent/computer/site-permissions'));
}

export async function describePermissions(page: Page, origin: string): Promise<string> {
  const { mine } = await forOrigin(page, origin);
  return `Permissions for ${origin}: ${SITE_PERMISSION_NAMES.map(name => `${name} ${mine.get(name) ?? 'denied (default)'}`).join(', ')}.`;
}
