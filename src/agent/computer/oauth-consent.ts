/** Presses through a vendor's OAuth consent screens in the ClikCode browser, already signed in, so connecting a ClikDeploy
 * connector is one action. What may be pressed is a table of data (per provider family), not logic: add a row to teach it a
 * screen. It never types: a login password, a verification code, a captcha or a screen it does not know is where it stops,
 * with a plain reason that holds no page text beyond the address and the names of what can be pressed. Success is not the
 * vendor's word for it: the callback page must be reached and ClikDeploy must then show an active connection. */
import { spawn } from 'node:child_process';
import type { Page } from 'playwright-core';
import { scrubSecrets } from './secret-scrubber.js';
import { detectBlocker } from './signup-recipes.js';
import { connectionState } from './secret-destinations.js';

/** One press: a control whose visible name matches `name`, only while the page text matches `when` (if given). */
export interface ConsentAction { note: string; name: RegExp; when?: RegExp; /** `leaf`: also a plain text element (Google's "Advanced"), not only buttons and links. */ leaf?: boolean }
export interface ConsentProvider { id: string; host: RegExp; actions: readonly ConsentAction[] }

/** Names that are never pressed, whatever else matches. */
const NEVER = /\b(deny|cancel|decline|reject|no thanks|not now|sign out|log ?out|remove|delete|back|create (?:an )?account|sign ?up|forgot)\b/i;

export const CONSENT_PROVIDERS: readonly ConsentProvider[] = [
  { id: 'google', host: /(^|\.)accounts\.google\.com$|(^|\.)google\.com$/i, actions: [
    { note: 'Continued past the unverified-app notice.', name: /^go to .*\(unsafe\)$/i },
    { note: 'Opened Advanced.', name: /^advanced$/i, leaf: true },
    { note: 'Allowed access.', name: /^(continue|allow|allow all)$/i },
    { note: 'Acknowledged the notice.', name: /^i understand$/i },
  ] },
  { id: 'microsoft', host: /(^|\.)(login\.microsoftonline\.com|login\.live\.com|microsoft\.com)$/i, actions: [
    { note: 'Accepted the permissions.', name: /^accept$/i },
    { note: 'Declined to stay signed in.', name: /^no$/i, when: /stay signed in/i },
  ] },
  { id: 'github', host: /(^|\.)github\.com$/i, actions: [
    { note: 'Authorized the app.', name: /^authori[sz]e\b[\w .-]{0,60}$/i },
  ] },
  { id: 'slack', host: /(^|\.)slack\.com$/i, actions: [
    { note: 'Allowed access.', name: /^(allow|authori[sz]e)$/i },
  ] },
  { id: 'atlassian', host: /(^|\.)(atlassian\.com|atlassian\.net)$/i, actions: [
    { note: 'Accepted access.', name: /^(accept|allow access)$/i },
  ] },
  { id: 'notion', host: /(^|\.)notion\.(so|com)$/i, actions: [
    { note: 'Allowed access.', name: /^(allow access|select pages|grant access)$/i },
  ] },
];

/** For every other vendor. "Continue" only on a page that is plainly asking for access. */
export const GENERIC_ACTIONS: readonly ConsentAction[] = [
  { note: 'Allowed access.', name: /^(allow( access)?|authori[sz]e( (app|access))?|accept|accept and continue|grant access|approve)$/i },
  { note: 'Continued on the permission screen.', name: /^continue$/i, when: /\b(access|permissions?|authori[sz]e|wants to|allow)\b/i },
];

export interface Control { name: string; leaf: boolean }

export const providerFor = (host: string): ConsentProvider | undefined => CONSENT_PROVIDERS.find(p => p.host.test(host));

const NOT_CHOOSER = /\b(sign out|log ?out|switch|remove|use another|add (?:an )?account|different account)\b/i;

/** What to press next on a page, as the index into `controls` and why, or undefined when nothing known is on it.
 * An account naming `email` is chosen first (once per address, which the caller tracks by passing `skipAccount`). */
export function nextPress(host: string, controls: readonly Control[], pageText: string, options: { email?: string; skipAccount?: boolean } = {}): { index: number; note: string } | undefined {
  const email = options.email?.trim().toLowerCase();
  if (email && !options.skipAccount) {
    const i = controls.findIndex(c => c.name.toLowerCase().includes(email) && !NOT_CHOOSER.test(c.name));
    if (i >= 0) return { index: i, note: 'Chose the account.' };
  }
  const table = [...(providerFor(host)?.actions ?? []), ...GENERIC_ACTIONS];
  for (const action of table) {
    if (action.when && !action.when.test(pageText)) continue;
    const i = controls.findIndex(c => (action.leaf || !c.leaf) && c.name.length <= 80 && !NEVER.test(c.name) && action.name.test(c.name));
    if (i >= 0) return { index: i, note: action.note };
  }
  return undefined;
}

/** The reason to stop at a page that needs the person, or undefined. A password box is the strongest sign: nothing is typed into it. */
export function stopReason(pageText: string, hasPasswordBox: boolean, hasCodeBox: boolean): string | undefined {
  const blocker = detectBlocker(pageText);
  if (blocker === 'a captcha') return 'a captcha';
  if (hasPasswordBox) return 'a login password (sign in first with the login action, which uses the saved login or Google)';
  if (hasCodeBox || blocker === 'an SMS or authenticator code') return 'a verification code (MFA)';
  return undefined;
}

/** Whether the page is ClikDeploy's callback landing (the authorization's redirect_uri), and what it says. */
export function callbackState(url: string, redirectUri: string | undefined, pageText: string): 'connected' | 'problem' | 'waiting' | 'elsewhere' {
  let here: URL;
  try { here = new URL(url); } catch { return 'elsewhere'; }
  let target: URL | undefined;
  try { target = redirectUri ? new URL(redirectUri) : undefined; } catch { target = undefined; }
  const onCallback = target ? here.origin === target.origin && here.pathname === target.pathname : /\/oauth\/callback\b|\/callback\b/.test(here.pathname);
  if (!onCallback) return 'elsewhere';
  if (/\b(error|denied|failed|invalid|expired|not connected|something went wrong)\b/i.test(pageText) && !/\bconnected\b/i.test(pageText.replace(/not connected/gi, ''))) return 'problem';
  if (/\b(connected|success|successfully|authori[sz]ed|you can (?:now )?close|all set)\b/i.test(pageText)) return 'connected';
  return 'waiting';
}

const CONNECTOR_ID = /^[A-Za-z0-9][\w.-]{0,60}$/;

/** The authorization URL out of whatever `clikdeploy integrations connect --no-browser` prints (JSON or a plain line). */
export function authorizationUrl(text: string): string | undefined {
  const walk = (value: unknown): string | undefined => {
    if (typeof value === 'string') return /^https?:\/\//.test(value) ? value : undefined;
    if (value && typeof value === 'object') for (const v of Object.values(value)) { const found = walk(v); if (found) return found; }
    return undefined;
  };
  const start = text.indexOf('{');
  if (start >= 0) { try { const found = walk(JSON.parse(text.slice(start))); if (found) return found; } catch { /* plain text */ } }
  return /https?:\/\/[^\s"'<>]+/.exec(text)?.[0]?.replace(/[.,;)]+$/, '');
}

export interface ConnectStart { url: string; stop: () => void }
export interface OAuthConsentOptions {
  email?: string; /** Treat every page as this provider's host (a test stands a fake vendor in for accounts.google.com). */ providerHost?: string; timeoutMs?: number; signal?: AbortSignal; progress?: (line: string) => void;
  /** Starts the connect and returns the authorization URL (default: `clikdeploy integrations connect <id> --no-browser`). */
  start?: (connector: string, signal?: AbortSignal) => Promise<ConnectStart>;
  /** Asks ClikDeploy whether the connector now has an active connection (default: `clikdeploy integrations show`). */
  status?: (connector: string, signal?: AbortSignal) => Promise<{ connected: boolean; reason?: string }>;
}

/** Runs the clikdeploy CLI (the saved admin key is its own sign-in) and waits for it to print the authorization URL. */
export function startViaCli(connector: string, signal?: AbortSignal): Promise<ConnectStart> {
  return new Promise((resolve, reject) => {
    const child = spawn('clikdeploy', ['integrations', 'connect', connector, '--no-browser'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let text = '';
    let settled = false;
    const stop = (): void => { child.kill(); };
    const timer = setTimeout(() => { if (!settled) { settled = true; stop(); reject(new Error('ClikDeploy did not return an authorization URL within a minute.')); } }, 60_000);
    const look = (final: boolean): void => {
      if (settled) return;
      const url = authorizationUrl(text);
      if (url) { settled = true; clearTimeout(timer); resolve({ url, stop }); return; }
      if (final) {
        settled = true; clearTimeout(timer);
        let said = text.trim().split('\n').slice(-3).join(' ').slice(0, 200);
        try { const j = JSON.parse(text.slice(text.indexOf('{'))) as { message?: string }; if (j.message) said = j.message.split('\n')[0]!; } catch { /* keep the tail */ }
        reject(new Error(`ClikDeploy would not start the connection for ${connector}: ${scrubSecrets(said) || 'no answer'}`));
      }
    };
    const feed = (chunk: unknown): void => { text = (text + String(chunk)).slice(-20_000); look(false); };
    child.stdout!.on('data', feed); child.stderr!.on('data', feed);
    child.once('error', error => { if (settled) return; settled = true; clearTimeout(timer); reject(new Error((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'The clikdeploy command is not installed on this computer.' : error.message)); });
    child.once('close', () => look(true));
    signal?.addEventListener('abort', stop, { once: true });
  });
}

const PRESSABLE = 'button, [role=button], a, [role=link], input[type=submit], input[type=button], summary, [data-identifier], [data-email], [data-test-id], [onclick]';

async function readControls(page: Page): Promise<Control[]> {
  return page.evaluate(({ pressable }) => {
    const out: { name: string; leaf: boolean }[] = [];
    const seen = new Set<string>();
    const doc = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<Record<string, unknown>> } }).document;
    const all = Array.from(doc.querySelectorAll(`${pressable}, span, div, p, li, label`)).slice(0, 1500) as unknown as Array<{ matches(s: string): boolean; getClientRects(): { length: number }; children: { length: number }; textContent: string | null; getAttribute(n: string): string | null; value?: string }>;
    for (const n of all) {
      if (!n.getClientRects().length) continue;
      const isPress = n.matches(pressable);
      if (!isPress && n.children.length) continue;
      const text = (n.getAttribute('aria-label') || n.value || n.textContent || '').replace(/\s+/g, ' ').trim();
      const ident = n.getAttribute('data-identifier') || n.getAttribute('data-email') || '';
      const name = (ident && !text.includes(ident) ? `${text} ${ident}` : text).trim();
      if (!name || name.length > 120) continue;
      const key = `${isPress}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, leaf: !isPress });
    }
    return out;
  }, { pressable: PRESSABLE });
}

async function press(page: Page, control: Control): Promise<boolean> {
  const exact = control.name;
  const candidates = control.leaf ? [page.getByText(exact, { exact: true })] : [page.getByRole('button', { name: exact, exact: true }), page.getByRole('link', { name: exact, exact: true }), page.locator(PRESSABLE).filter({ hasText: exact }), page.getByText(exact, { exact: true })];
  for (const base of candidates) {
    const shown = base.filter({ visible: true });
    if (!(await shown.count().catch(() => 0))) continue;
    if (await shown.first().click({ timeout: 3_000 }).then(() => true, () => false)) return true;
  }
  return false;
}

/** Where the browser is when consent stalls: the address (no query) and the names of what can be pressed (never an address or a field value). */
function stuckOn(page: Page, controls: readonly Control[]): string {
  try {
    const url = new URL(page.url());
    const names = [...new Set(controls.filter(c => !c.leaf && !c.name.includes('@')).map(c => c.name))].slice(0, 10);
    return `The browser is on ${url.host}${url.pathname}; it shows: ${scrubSecrets(names.join(' | ')) || 'nothing to press'}.`;
  } catch { return ''; }
}

export class ConsentStop extends Error {}

/** Connects `connector` for the signed-in ClikDeploy account by driving its OAuth consent in `page`. */
export async function oauthConnect(connector: string, page: Page, options: OAuthConsentOptions = {}): Promise<{ connector: string; steps: string[] }> {
  if (!CONNECTOR_ID.test(connector)) throw new Error('oauth_connect needs target: a connector id such as slack or github.');
  const started = await (options.start ?? startViaCli)(connector, options.signal);
  const status = options.status ?? ((id, signal) => connectionState(id, signal));
  const steps: string[] = [];
  try {
    let redirectUri: string | undefined;
    try { redirectUri = new URL(started.url).searchParams.get('redirect_uri') ?? undefined; } catch { redirectUri = undefined; }
    await page.goto(started.url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    const deadline = Date.now() + (options.timeoutMs ?? 120_000);
    let idle = 0, stopSeen = 0, chosenOn = '', lastPress = { key: '', at: 0 }, controls: Control[] = [];
    while (Date.now() < deadline) {
      if (options.signal?.aborted) throw new Error('Stopped.');
      if (page.isClosed()) throw new ConsentStop('The browser tab was closed before consent finished.');
      const url = page.url();
      const text = await page.evaluate(() => ((globalThis as unknown as { document: { body?: { innerText?: string } } }).document.body?.innerText ?? '').slice(0, 6000)).catch(() => '');
      const at = callbackState(url, redirectUri, text);
      if (at === 'problem') throw new ConsentStop(`The callback page reported a problem instead of a connection (${new URL(url).host}${new URL(url).pathname}). Check the consent was allowed and try again.`);
      if (at === 'connected' || at === 'waiting') {
        // The landing page loads and then ClikDeploy stores the tokens: ask ClikDeploy, not the page.
        let last = '';
        for (let tries = 0; tries < 8; tries++) {
          const state = await status(connector, options.signal);
          if (state.connected) { steps.push('Confirmed: ClikDeploy shows an active connection.'); return { connector, steps }; }
          last = state.reason ?? '';
          await page.waitForTimeout(2_500).catch(() => undefined);
        }
        throw new ConsentStop(`The callback page was reached but ClikDeploy shows no active connection${last ? ` (${scrubSecrets(last)})` : ''}.`);
      }
      const hasPassword = await page.locator('input[type=password]:visible').count().catch(() => 0) > 0;
      const hasCode = await page.locator('input[autocomplete=one-time-code]:visible').count().catch(() => 0) > 0;
      const why = stopReason(text, hasPassword, hasCode);
      controls = await readControls(page).catch(() => []);
      if (why) {
        // Two looks in a row, so a page still settling does not stop it.
        if (++stopSeen >= 2) throw new ConsentStop(`Stopped at ${why}. Nothing was typed. ${stuckOn(page, controls)}`);
      } else {
        stopSeen = 0;
        const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
        const next = nextPress(options.providerHost ?? host, controls, text, { ...(options.email ? { email: options.email } : {}), skipAccount: chosenOn === url });
        const control = next && controls[next.index];
        if (next && control && !(lastPress.key === `${url}|${control.name}` && Date.now() - lastPress.at < 2_500)) {
          if (next.note === 'Chose the account.') chosenOn = url;
          if (await press(page, control)) {
            lastPress = { key: `${url}|${control.name}`, at: Date.now() };
            steps.push(next.note); options.progress?.(`${next.note}\n`);
            idle = 0;
          }
        } else if (++idle >= 15) throw new ConsentStop(`Stopped at a screen it does not recognize. ${stuckOn(page, controls)}`);
      }
      await page.waitForTimeout(700).catch(() => undefined);
    }
    throw new ConsentStop(`Consent did not finish in time. ${stuckOn(page, controls)}`);
  } finally { started.stop(); }
}
