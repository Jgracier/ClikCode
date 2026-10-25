/** Post-login exploration for keygrab: once signed in, a vendor's API key page is rarely a link on the landing page. It sits behind the
 * avatar / account menu, a settings or organisation page, a workspace switcher or a left-hand navigation. This reads those places in a
 * fixed order and follows only items that read like a key page (api, developer, key, token, integration, access, credentials), within
 * a page budget, recording every page and menu it looked at. It never presses a destructive item (delete, cancel a plan, sign out,
 * billing). It only drives the small `ExploreDeps` surface, so it is tested with fake pages. */
import type { KeyControl, KeyView } from './keygrab.js';

export const KEY_WORDS = /\b(?:api|developers?|keys?|tokens?|integrations?|access|credentials?)\b/i;
/** Never pressed, whatever else the item says. */
export const DESTRUCTIVE = /\b(?:delete|remove|cancel|sign ?out|log ?out|logout|billing|invoices?|upgrade|downgrade|subscriptions?|plans?|payments?|pricing|deactivate|close (?:my )?account|disconnect|unsubscribe|purchase|buy|checkout|revoke|reset|regenerat\w*|rotate|roll|deauthori[sz]e|leave)\b/i;
/** Places a key page tends to hide behind. */
const SETTINGS_WORDS = /\b(?:settings|account|profile|organi[sz]ations?|workspaces?|team|admin|preferences|security|my account|manage|console|dashboard|projects?)\b/i;
/** The button that opens an avatar, account, settings, organisation or workspace menu. */
const OPENER_WORDS = /\b(?:account|profile|avatar|user(?: menu)?|my account|settings|workspace|organi[sz]ation|org|team|switch|switcher|menu|you|me)\b/i;
const SKIP_ONBOARDING = /^(?:skip(?: for now| this step| tour)?|maybe later|not now|no,? thanks|remind me later)$/i;
const SEARCH_FIELD = /search|find/i;

export interface ExploreDeps {
  /** The page as it is now (a wall on it ends the run by throwing). */
  look(): Promise<KeyView>;
  click(name: string): Promise<boolean>;
  open(url: string): Promise<KeyView | undefined>;
  fill(name: string, text: string): Promise<string | undefined>;
  press?(key: string): Promise<string | undefined>;
  isKeyPage(view: KeyView): boolean;
  /** The page asks for a sign-in: the session is not signed in, so exploring further is pointless. */
  needsSignIn(view: KeyView): boolean;
  sleep(ms: number): Promise<void>;
  say?(line: string): void;
}
export interface ExploreResult { found?: KeyView; visited: string[]; menus: string[]; tried: string[]; last: KeyView; needsSignIn?: boolean }

interface Candidate { name: string; href?: string; from: string; via?: string; rank: number }

const pathOf = (url: string): string => { try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return url; } };
const safe = (name: string): boolean => name.length > 0 && name.length <= 60 && !DESTRUCTIVE.test(name);
const keyWord = (name: string): boolean => KEY_WORDS.test(name) && safe(name);
const settingsWord = (name: string): boolean => SETTINGS_WORDS.test(name) && safe(name);
const httpsHref = (c: KeyControl): string | undefined => { try { const u = new URL(c.href ?? ''); return u.protocol === 'https:' ? u.href : undefined; } catch { return undefined; } };

/** Controls of `view` that were not on `before`: what a menu or dialog just added. */
function added(view: KeyView, before: KeyView): KeyControl[] {
  const had = new Set(before.controls.map(c => c.name));
  return view.controls.filter(c => !had.has(c.name));
}

/** Which controls open a menu: flagged by the page (aria-haspopup / aria-expanded), or named like an avatar, account or switcher, or the signed-in address or initials. */
export function menuOpeners(view: KeyView, email?: string): KeyControl[] {
  const mail = email?.toLowerCase();
  return view.controls.filter(c => !c.leaf && !c.footer && c.name.length <= 80 && !DESTRUCTIVE.test(c.name)
    && (c.menu === true || OPENER_WORDS.test(c.name) || (mail && c.name.toLowerCase().includes(mail)) || /^[A-Z]{1,2}$/.test(c.name.trim()) || /@/.test(c.name)))
    .sort((a, b) => Number(b.menu === true) - Number(a.menu === true));
}

export async function exploreForKeys(deps: ExploreDeps, start: KeyView, options: { maxPages?: number; email?: string; seen?: string[]; seenMenus?: string[]; searchWords?: string } = {}): Promise<ExploreResult> {
  const maxPages = options.maxPages ?? 8;
  const visited: string[] = [...(options.seen ?? [])];
  const menus: string[] = [...(options.seenMenus ?? [])];
  const tried = new Set<string>();
  const queued = new Set<string>();
  const frontier: Candidate[] = [];
  let pages = 0;
  let current = start;
  let needsSignIn = false;
  const hit: { v?: KeyView } = {};
  const record = (v: KeyView): void => { const p = pathOf(v.url); if (p && !visited.includes(p)) visited.push(p); };
  const done = (found?: KeyView): ExploreResult => ({ ...(found ? { found } : {}), visited, menus, tried: [...tried], last: current, ...(needsSignIn ? { needsSignIn } : {}) });
  record(start);

  const enqueue = (c: KeyControl, from: string, rank: number, via?: string): void => {
    const href = httpsHref(c);
    const key = href ? pathOf(href) : `${via ?? ''}>${c.name}`;
    if (queued.has(key) || (href && visited.includes(pathOf(href)))) return;
    queued.add(key);
    frontier.push({ name: c.name, ...(href ? { href } : {}), from, ...(via ? { via } : {}), rank });
    frontier.sort((a, b) => a.rank - b.rank);
  };
  /** Rank 0: reads like a key page. Rank 2: a settings or organisation page that may contain one. Navigation items count the same. */
  const harvest = (v: KeyView, via?: string, items: KeyControl[] = v.controls): void => {
    for (const c of items) {
      if (c.leaf && !c.href) continue;
      if (!safe(c.name) || (c.footer && !keyWord(c.name))) continue;
      if (keyWord(c.name)) enqueue(c, v.url, c.footer ? 1 : 0, via);
      else if (settingsWord(c.name) && (c.nav || via || c.menu)) enqueue(c, v.url, 2, via);
    }
  };

  const visit = async (c: Candidate): Promise<KeyView | undefined> => {
    tried.add(c.name);
    let v: KeyView | undefined;
    if (c.href) v = await deps.open(c.href);
    else {
      if (pathOf(current.url) !== pathOf(c.from)) { const back = await deps.open(c.from); if (!back) return undefined; current = back; }
      if (c.via && !(await deps.click(c.via))) return undefined;
      if (c.via) await deps.sleep(300);
      if (!(await deps.click(c.name))) return undefined;
      await deps.sleep(700);
      v = await deps.look();
    }
    if (!v) return undefined;
    pages++;
    current = v;
    record(v);
    deps.say?.(`explored ${pathOf(v.url)}`);
    return v;
  };

  /** Open each account, avatar or switcher menu on `view`, read its items, and queue the ones worth following. */
  const readMenus = async (view: KeyView): Promise<void> => {
    let opened = 0;
    for (const opener of menuOpeners(view, options.email)) {
      if (opened >= 3 || tried.has(`menu:${opener.name}`)) continue;
      tried.add(`menu:${opener.name}`);
      if (!(await deps.click(opener.name))) continue;
      opened++;
      await deps.sleep(350);
      const after = await deps.look();
      const items = added(after, view).filter(c => !c.leaf || c.href);
      if (items.length) menus.push(`${opener.name}: ${items.map(c => c.name).slice(0, 14).join(' | ')}`.slice(0, 300));
      current = after;
      harvest(after, opener.name, items);
      // The menu is open now: a key item with no address of its own is pressed here, while it exists.
      const direct = frontier.find(c => c.via === opener.name && !c.href && c.rank === 0);
      if (direct && pages < maxPages) {
        frontier.splice(frontier.indexOf(direct), 1);
        tried.add(direct.name);
        if (await deps.click(direct.name)) {
          await deps.sleep(700);
          const v = await deps.look();
          pages++; current = v; record(v);
          if (deps.isKeyPage(v)) { hit.v = v; return; }
          harvest(v);
          return;
        }
      }
      if (deps.press) { await deps.press('Escape'); await deps.sleep(200); current = await deps.look(); }
    }
  };
  const search = async (view: KeyView): Promise<void> => {
    const field = view.fields.find(f => SEARCH_FIELD.test(f));
    if (!field || !deps.press || tried.has('search')) return;
    tried.add('search');
    if (await deps.fill(field, options.searchWords ?? 'API key')) return;
    if (await deps.press('Enter')) return;
    await deps.sleep(900);
    const v = await deps.look();
    menus.push(`search "API key": ${v.controls.filter(c => !c.leaf || c.href).map(c => c.name).slice(0, 10).join(' | ')}`.slice(0, 300));
    pages++; current = v; record(v);
    if (deps.isKeyPage(v)) { hit.v = v; return; }
    harvest(v);
  };

  // A first-run tour or welcome screen: skip it, it hides the real page.
  const skip = start.controls.find(c => !c.leaf && !c.footer && SKIP_ONBOARDING.test(c.name.trim()));
  if (skip && await deps.click(skip.name)) { await deps.sleep(500); current = await deps.look(); if (deps.isKeyPage(current)) return done(current); }

  const first = current;
  harvest(first);
  // The key-ish links already on the page first, then the account menus, then the site's own search, then settings pages.
  while (!hit.v && frontier[0]?.rank === 0 && pages < maxPages) {
    const next = frontier.shift()!;
    const v = await visit(next);
    if (!v) continue;
    if (deps.needsSignIn(v)) { needsSignIn = true; return done(); }
    if (deps.isKeyPage(v)) return done(v);
    harvest(v);
  }
  if (!hit.v && pages < maxPages) { await readMenus(first); }
  if (hit.v) return done(hit.v);
  if (pages < maxPages) { await search(first); }
  if (hit.v) return done(hit.v);
  while (frontier.length && pages < maxPages) {
    const next = frontier.shift()!;
    const v = await visit(next);
    if (!v) continue;
    if (deps.needsSignIn(v)) { needsSignIn = true; return done(); }
    if (deps.isKeyPage(v)) return done(v);
    harvest(v);
  }
  return done();
}
