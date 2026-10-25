/** The real port of keygrab: ClikCode's hidden browser through the `computer_web` tool (so its recorder saves the recipe as the actions
 * succeed) and a plain look at the page for what it shows. Nothing here prints or logs a key: capture is the tool's own unseen capture. */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import type { DriveOutcome } from './connector-runner.js';
import type { KeyControl, KeyView, KeygrabPort } from './keygrab.js';
import type { ParkedRecord } from './keygrab-park.js';
import { scrubSecrets } from './secret-scrubber.js';

const TAB = 'connectors';
const clean = (text: string): string => scrubSecrets(text).replace(/\s+/g, ' ').trim().slice(0, 300);

/** Runs in the page (and in each frame): the visible text, what can be pressed, the visible boxes by label, and a real captcha challenge. */
function collectView(): { text: string; controls: KeyControl[]; fields: string[]; hasPassword: boolean; captchaFrame: boolean } {
  const doc = (globalThis as unknown as { document: { body?: { innerText?: string }; querySelectorAll(s: string): ArrayLike<Record<string, unknown>> } }).document;
  type El = { closest(s: string): unknown; matches(s: string): boolean; getClientRects(): { length: number }; children: { length: number }; textContent: string | null; getAttribute(n: string): string | null; value?: string; href?: string; labels?: ArrayLike<{ textContent: string | null }>; type?: string; tagName: string };
  const norm = (t: string | null | undefined): string => (t ?? '').replace(/\s+/g, ' ').trim();
  const pressable = 'button, [role=button], a, [role=link], [role=menuitem], [role=tab], input[type=submit], input[type=button], summary';
  const controls: KeyControl[] = [];
  const seenNames = new Set<string>();
  for (const n of Array.from(doc.querySelectorAll(`${pressable}, span, div, p, li, label`)).slice(0, 1500) as unknown as El[]) {
    if (!n.getClientRects().length) continue;
    const isPress = n.matches(pressable);
    if (!isPress && n.children.length) continue;
    const name = norm(n.getAttribute('aria-label') || n.value || n.textContent);
    if (!name || name.length > 120) continue;
    const key = `${isPress}|${name}`;
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    const popup = n.getAttribute('aria-haspopup');
    controls.push({
      name, leaf: !isPress,
      ...(n.tagName === 'A' && n.href ? { href: n.href } : {}),
      ...(n.closest('footer, [role=contentinfo]') ? { footer: true } : {}),
      ...(n.closest('nav, aside, [role=navigation], [role=complementary]') ? { nav: true } : {}),
      ...(name.length <= 40 && ((popup && popup !== 'false') || n.getAttribute('aria-expanded') === 'false' || n.closest('[aria-haspopup]:not([aria-haspopup=false]), [aria-expanded=false], [role=listbox], [role=combobox], .dropdown, [class*=dropdown], [class*=avatar], [class*=user-menu], [class*=UserMenu]')) ? { menu: true } : {}),
    });
  }
  const fields: string[] = [];
  let hasPassword = false;
  for (const n of Array.from(doc.querySelectorAll('input, textarea')) as unknown as El[]) {
    if (!n.getClientRects().length || /^(hidden|checkbox|radio|submit|button|file|image)$/.test(n.type ?? '')) continue;
    if (n.type === 'password') hasPassword = true;
    const name = norm(n.getAttribute('aria-label')) || norm(n.labels?.[0]?.textContent) || norm(n.getAttribute('placeholder'));
    if (name && !fields.includes(name)) fields.push(name);
  }
  // A real captcha shows a challenge frame of a usable size; the invisible badge and tracking frames do not count.
  let captchaFrame = false;
  for (const f of Array.from(doc.querySelectorAll('iframe')) as unknown as Array<{ getAttribute(n: string): string | null; getBoundingClientRect(): { width: number; height: number } }>) {
    const src = f.getAttribute('src') ?? '', box = f.getBoundingClientRect();
    if (/recaptcha\/api2\/bframe|hcaptcha\.com\/captcha|challenges\.cloudflare\.com|turnstile|funcaptcha|arkoselabs/i.test(src) && box.width >= 280 && box.height >= 70) captchaFrame = true;
    else if (/recaptcha\/api2\/anchor/i.test(src) && box.width >= 280 && box.height >= 70) captchaFrame = true;
  }
  return { text: (doc.body?.innerText ?? '').slice(0, 6000), controls, fields, hasPassword, captchaFrame };
}

/** Frames that are the page's own forms and widgets (a sign-up form, a sign-in button) are read; captcha challenges, ads and trackers are not. */
const SKIP_FRAME = /recaptcha|hcaptcha|challenges\.cloudflare|turnstile|arkoselabs|funcaptcha|doubleclick|googletagmanager|googlesyndication|facebook\.com\/tr|youtube\.com|vimeo\.com|google\.com\/maps|stripe\.com\/(?:v3|elements-inner-(?:fraud|controller))|intercom|crisp\.chat|hotjar|clarity\.ms/i;
const MAX_FRAMES = 6;

/** What the page shows: its text, what can be pressed (with the address of a link), and the visible boxes by their label. The visible
 * controls and text of iframes (same-origin or not) are read too, so a sign-up form inside a frame is seen like any other. */
export async function lookAt(page: Page): Promise<KeyView> {
  const seen = await page.evaluate(collectView).catch(() => ({ text: '', controls: [] as KeyControl[], fields: [] as string[], hasPassword: false, captchaFrame: false }));
  const controls = [...seen.controls];
  const fields = [...seen.fields];
  let text = seen.text, hasPassword = seen.hasPassword;
  let read = 0;
  for (const frame of page.frames()) {
    if (frame === page.mainFrame() || read >= MAX_FRAMES) continue;
    const src = frame.url();
    if (!src || src === 'about:blank' || SKIP_FRAME.test(src)) continue;
    try {
      const element = await frame.frameElement();
      const box = await element.boundingBox();
      if (!box || box.width < 40 || box.height < 24) continue;
      const inside = await Promise.race([frame.evaluate(collectView), new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 3_000))]);
      if (!inside) continue;
      read++;
      const have = new Set(controls.map(c => `${c.leaf ? 'l' : 'p'}|${c.name}`));
      for (const c of inside.controls) if (!have.has(`${c.leaf ? 'l' : 'p'}|${c.name}`)) controls.push({ ...c, frame: true });
      for (const f of inside.fields) if (!fields.includes(f)) fields.push(f);
      if (inside.hasPassword) hasPassword = true;
      if (inside.text.trim()) text = `${text}\n${inside.text}`.slice(0, 8000);
    } catch { /* a frame that went away or cannot be read is skipped */ }
  }
  return { url: page.url(), text, controls, fields, hasPassword, ...(seen.captchaFrame ? { captchaFrame: true } : {}) };
}

export interface LiveKeygrabOptions { stateDir: string; id: string; signal?: AbortSignal; screenshotDir?: () => Promise<string> }

export async function liveKeygrabPort(options: LiveKeygrabOptions): Promise<KeygrabPort> {
  const { computerWebTool } = await import('../tools/computer-web.js');
  const { computerPage } = await import('./browser.js');
  const { listProfiles } = await import('./profiles.js');
  const ctx = { stateDir: options.stateDir, ...(options.signal ? { signal: options.signal } : {}) } as Parameters<typeof computerWebTool.run>[1];
  const run = (args: Record<string, unknown>) => computerWebTool.run({ tab: TAB, ...args } as never, ctx);
  const page = (): Promise<Page> => computerPage(options.stateDir, TAB);
  const shots = options.screenshotDir ?? (() => mkdtemp(join(tmpdir(), 'clikcode-connector-shots-')));
  const failed = (r: { output: string; isError?: boolean }): string | undefined => r.isError ? clean(r.output) : undefined;
  return {
    open: async url => failed(await run({ action: 'open', url })),
    look: async () => lookAt(await page()),
    click: async name => failed(await run({ action: 'click', target: name })),
    press: async key => failed(await run({ action: 'press', key })),
    fill: async (name, text) => failed(await run({ action: 'fill', target: name, ...(text !== undefined ? { text } : {}) })),
    login: async () => { const r = await run({ action: 'login' }); return { ok: !r.isError, message: clean(r.output.split('\n')[0] ?? '') }; },
    emailCode: async () => {
      for (const subject of ['verification', 'code', 'confirm']) {
        const r = await run({ action: 'read_email_code', subject, seconds: 45 });
        const code = r.isError ? undefined : /Code:\s*([A-Za-z0-9-]{4,10})\b/.exec(r.output)?.[1];
        if (code) return code;
      }
      return undefined;
    },
    emailLink: async () => {
      for (const subject of ['verify', 'confirm', 'welcome']) if (!(await run({ action: 'open_email_link', subject, seconds: 45 })).isError) return true;
      return false;
    },
    capture: async target => {
      const r = await run({ action: 'capture_secret', ...(target ? { target } : {}), secret_name: `${options.id}/key`, vendor: options.id, send_to: [{ to: 'clikdeploy-connection', with: { integration: options.id } }] });
      return { ok: !r.isError, message: clean(r.output) };
    },
    probe: async url => {
      try {
        const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8_000), headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36', accept: 'text/html,application/xhtml+xml' } });
        const type = res.headers.get('content-type') ?? '';
        await res.body?.cancel().catch(() => undefined);
        return { html: /html/i.test(type), status: res.status, url: res.url || url };
      } catch { return undefined; }
    },
    screenshot: async () => {
      try { const p = await page(); if (p.isClosed()) return undefined; const path = join(await shots(), `${options.id}.png`); await p.screenshot({ path, timeout: 10_000 }); return path; } catch { return undefined; }
    },
    profileEmail: async () => (await listProfiles(options.stateDir)).map(profile => profile.fields.sso_email).find(Boolean),
  };
}

export interface KeygrabBudget { maxMs: number; alternates?: string[]; maxSteps?: number; /** A resumed run: the tab is already attached; carry on with what the parked record knew. */ resume?: ParkedRecord }

/** The `keygrab` driver method: runs the policy, then says whether a recipe was recorded for the host. A run that cannot finish leaves its
 * hidden tab open on the last page (parked, with a record of the trail) so `clikcode connectors resume <id>` can carry on from there. */
export async function liveKeygrab(options: { stateDir: string; signal?: AbortSignal; screenshotDir?: () => Promise<string> }, id: string, url: string, budget: KeygrabBudget): Promise<DriveOutcome> {
  const [{ runKeygrab }, { listRecipes }, browser, recorder, park] = await Promise.all([import('./keygrab.js'), import('./signup-recipes.js'), import('./browser.js'), import('./recipe-recorder.js'), import('./keygrab-park.js')]);
  const { closeComputerPage, releaseComputerBrowser } = browser;
  const stamp = async (): Promise<string> => (await listRecipes(options.stateDir).catch(() => [])).map(r => `${r.host}:${r.loginRoute}:${r.verifiedAt}`).sort().join('|');
  /** The hosts whose recipe changed between two stamps (the key page is often on another host than the vendor's front page). */
  const changed = (a: string, b: string): string[] => b.split('|').filter(x => x && !a.split('|').includes(x)).map(x => x.split(':')[0]!);
  const before = await stamp();
  const journalKey = `${options.stateDir}#${TAB}`;
  let parked = false;
  try {
    const marker = park.markerFor(id);
    const port = await liveKeygrabPort({ ...options, id });
    const done = await runKeygrab(port, {
      id, url, maxMs: budget.maxMs, ...(budget.maxSteps ? { maxSteps: budget.maxSteps } : {}), ...(budget.alternates?.length ? { alternates: budget.alternates } : {}),
      ...(budget.resume ? { resume: { visited: budget.resume.visited, menus: budget.resume.menus, ...(budget.resume.signedIn ? { signedIn: true } : {}) } } : {}),
    });
    if (done.ok) {
      await park.clearParked(options.stateDir, id);
      await browser.closeParkedPage(options.stateDir, marker).catch(() => undefined);
      const hosts = [...new Set(changed(before, await stamp()))];
      return { ok: true, note: `${done.note} (${done.steps} browser actions, signed in via ${done.route}; ${hosts.length ? `a recipe for ${hosts.join(', ')} was recorded` : 'no new recipe was recorded'})`, actions: done.steps, recipe: hosts.length > 0 };
    }
    // Not finished: keep the hidden tab where it is. A tab parked earlier for this vendor is replaced (unless it is the one being resumed).
    if (!budget.resume) await browser.closeParkedPage(options.stateDir, marker).catch(() => undefined);
    const stop = done.stop;
    const record: ParkedRecord = {
      id, marker, parkedAt: new Date().toISOString(), url: stop.url, vendorUrl: url, ...(budget.alternates?.length ? { alternates: budget.alternates } : {}),
      trail: [...(budget.resume?.trail ?? []), ...(stop.trail ?? [])].slice(-40), controls: stop.controls, visited: stop.visited ?? [], menus: stop.menus ?? [], ...((stop.signedIn || budget.resume?.signedIn) ? { signedIn: true } : {}), why: stop.message.slice(0, 300),
      ...(recorder.exportJournal(journalKey) ? { journal: recorder.exportJournal(journalKey)! } : {}),
    };
    parked = await browser.parkComputerPage(options.stateDir, TAB, marker);
    if (parked) {
      await park.saveParked(options.stateDir, record);
      for (const old of (await park.listParked(options.stateDir)).slice(0, -park.MAX_PARKED)) { await browser.closeParkedPage(options.stateDir, old.marker).catch(() => undefined); await park.clearParked(options.stateDir, old.id); }
    }
    return { ok: false, stop: { ...stop, vendorUrl: url, ...(parked ? { parked: true } : {}) } };
  } finally {
    if (!parked) await closeComputerPage(options.stateDir, TAB).catch(() => undefined);
    await releaseComputerBrowser(options.stateDir).catch(() => undefined);
  }
}
