/** The real port of keygrab: ClikCode's hidden browser through the `computer_web` tool (so its recorder saves the recipe as the actions
 * succeed) and a plain look at the page for what it shows. Nothing here prints or logs a key: capture is the tool's own unseen capture. */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import type { DriveOutcome } from './connector-runner.js';
import type { KeyControl, KeyView, KeygrabPort } from './keygrab.js';
import { scrubSecrets } from './secret-scrubber.js';

const TAB = 'connectors';
const clean = (text: string): string => scrubSecrets(text).replace(/\s+/g, ' ').trim().slice(0, 300);

/** What the page shows: its text, what can be pressed (with the address of a link), and the visible boxes by their label. */
export async function lookAt(page: Page): Promise<KeyView> {
  const seen = await page.evaluate(() => {
    const doc = (globalThis as unknown as { document: { body?: { innerText?: string }; querySelectorAll(s: string): ArrayLike<Record<string, unknown>> } }).document;
    type El = { matches(s: string): boolean; getClientRects(): { length: number }; children: { length: number }; textContent: string | null; getAttribute(n: string): string | null; value?: string; href?: string; labels?: ArrayLike<{ textContent: string | null }>; type?: string; tagName: string };
    const norm = (t: string | null | undefined): string => (t ?? '').replace(/\s+/g, ' ').trim();
    const pressable = 'button, [role=button], a, [role=link], [role=menuitem], input[type=submit], input[type=button], summary';
    const controls: { name: string; leaf: boolean; href?: string }[] = [];
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
      controls.push({ name, leaf: !isPress, ...(n.tagName === 'A' && n.href ? { href: n.href } : {}) });
    }
    const fields: string[] = [];
    let hasPassword = false;
    for (const n of Array.from(doc.querySelectorAll('input, textarea')) as unknown as El[]) {
      if (!n.getClientRects().length || /^(hidden|checkbox|radio|submit|button|file|image)$/.test(n.type ?? '')) continue;
      if (n.type === 'password') hasPassword = true;
      const name = norm(n.getAttribute('aria-label')) || norm(n.labels?.[0]?.textContent) || norm(n.getAttribute('placeholder'));
      if (name && !fields.includes(name)) fields.push(name);
    }
    return { text: (doc.body?.innerText ?? '').slice(0, 6000), controls, fields, hasPassword };
  }).catch(() => ({ text: '', controls: [] as KeyControl[], fields: [] as string[], hasPassword: false }));
  return { url: page.url(), ...seen };
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
    screenshot: async () => {
      try { const p = await page(); if (p.isClosed()) return undefined; const path = join(await shots(), `${options.id}.png`); await p.screenshot({ path, timeout: 10_000 }); return path; } catch { return undefined; }
    },
    profileEmail: async () => (await listProfiles(options.stateDir)).map(profile => profile.fields.sso_email).find(Boolean),
  };
}

/** The `keygrab` driver method: runs the policy, then says whether a recipe was recorded for the host. */
export async function liveKeygrab(options: { stateDir: string; signal?: AbortSignal; screenshotDir?: () => Promise<string> }, id: string, url: string, budget: { maxMs: number }): Promise<DriveOutcome> {
  const [{ runKeygrab }, { listRecipes }, { closeComputerPage, releaseComputerBrowser }] = await Promise.all([import('./keygrab.js'), import('./signup-recipes.js'), import('./browser.js')]);
  const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  const stamp = async (): Promise<string> => (await listRecipes(options.stateDir).catch(() => [])).filter(r => host && (r.host === host || host.endsWith(`.${r.host}`) || r.host.endsWith(`.${host}`))).map(r => `${r.host}:${r.loginRoute}:${r.verifiedAt}`).sort().join('|');
  const before = await stamp();
  try {
    const port = await liveKeygrabPort({ ...options, id });
    const done = await runKeygrab(port, { id, url, maxMs: budget.maxMs });
    if (!done.ok) return { ok: false, stop: done.stop };
    const after = await stamp();
    return { ok: true, note: `${done.note} (${done.steps} browser actions, signed in via ${done.route}; ${after !== before ? `a signup recipe for ${host} was recorded` : 'no new recipe was recorded'})` };
  } finally {
    await closeComputerPage(options.stateDir, TAB).catch(() => undefined);
    await releaseComputerBrowser(options.stateDir).catch(() => undefined);
  }
}
