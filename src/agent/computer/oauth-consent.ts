/** Presses through a vendor's OAuth consent screens in the ClikCode browser, already signed in, so connecting a ClikDeploy
 * connector is one action. What may be pressed is a table of data (per provider family), not logic: add a row to teach it a
 * screen. It never types: a login password, a verification code, a captcha or a screen it does not know is where it stops,
 * with a plain reason that holds no page text beyond the address and the names of what can be pressed. Success is not the
 * vendor's word for it: the callback page must be reached and ClikDeploy must then show an active connection. */
import { quiet } from '../../runtime/lifecycle-log.js';
import { spawn } from 'node:child_process';
import type { Page } from 'playwright-core';
import { scrubSecrets } from './secret-scrubber.js';
import { detectBlocker } from './signup-recipes.js';
import { connectionState } from './secret-destinations.js';
import { saveTask, type TaskReason } from './work-queue.js';

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

/** A link whose address starts a program other than the page (mailto:, tel:, sms:, callto:, facetime:, an app's own scheme). The browser hands
 * it to the operating system, which opens a mail client or a chooser, and the page never moves on: the sign-in driver would press it again.
 * Google's "hasn't verified this app" page prints the developer's address as a mailto: link, which a text match for the profile's email took for
 * the account to choose. Web, javascript:, about: and relative addresses are the page's own. */
export const OPENS_ANOTHER_APP = /^\s*(?!https?:|javascript:|about:)[a-z][a-z0-9+.-]*:/i;

const NOT_CHOOSER = /\b(sign out|log ?out|switch|remove|use another|add (?:an )?account|different account)\b/i;

/** The platform's own name as a vendor's consent page shows it ("Authorize ClikDeploy"). */
export const PLATFORM_APP = 'ClikDeploy';

/** An affirmative consent control: Authorize [app], Allow [access], Approve, Accept, Grant access, Continue as <account>. Never "Continue with <provider>" (a sign-in). */
const AFFIRMATIVE = /^(?:authori[sz]e(?: [\w .'&-]{1,60})?|allow(?: access| all)?|approve(?: [\w .'&-]{1,40})?|accept(?: and continue)?|grant(?: access| permission)?|continue as [\w .'@+-]{1,80})$/i;
/** A refusal that a real consent page sits beside its affirmative control. */
const NEGATIVE = /^(?:cancel|deny|decline|reject|no,? thanks|not now|do not allow)$/i;

export interface ConsentReading { consent: boolean; /** index into controls of the control to press */ index?: number }

/** Whether a page is a consent screen, and which control grants it: the page names the platform (or its callback), offers an affirmative
 * control and a negative one. Not vendor-specific. A payment, missing credits, unknown-client or captcha page never qualifies. */
export function readConsent(controls: readonly Control[], pageText: string, options: { appNames?: readonly string[]; redirectHost?: string } = {}): ConsentReading {
  if (classifyStuck(pageText) || detectBlocker(pageText) === 'a captcha') return { consent: false };
  const names = (options.appNames ?? [PLATFORM_APP]).filter(Boolean);
  const lower = pageText.toLowerCase();
  const mentions = names.some(n => lower.includes(n.toLowerCase())) || (!!options.redirectHost && lower.includes(options.redirectHost.toLowerCase()))
    || controls.some(c => !c.leaf && names.some(n => c.name.toLowerCase().includes(n.toLowerCase())) && AFFIRMATIVE.test(c.name));
  if (!mentions) return { consent: false };
  const presses = controls.filter(c => !c.leaf);
  if (!presses.some(c => NEGATIVE.test(c.name))) return { consent: false };
  const index = controls.findIndex(c => !c.leaf && c.name.length <= 100 && !NEVER.test(c.name) && AFFIRMATIVE.test(c.name));
  return index >= 0 ? { consent: true, index } : { consent: false };
}

/** A tick box on a consent page (Google's granular-consent screen offers "Select all" and one per scope). `index` is its place among the page's boxes. */
export interface ScopeBox { index: number; name: string; checked: boolean }

const SELECT_ALL = /^select all\b/i;
/** Boxes that are not scopes (marketing, remember-me, terms) and are never ticked here. */
const NOT_A_SCOPE = /\b(newsletter|marketing|promotion|offers?|subscribe|remember|keep me|stay signed|don'?t ask|do not ask|terms|privacy|robot|human)\b/i;

/** Which boxes to tick before the affirmative press: on a recognized consent page (it names the app or the redirect; never a payment,
 * credits, unknown-client or captcha page) with unticked scope boxes, "Select all" when it is offered, else every unticked scope box. */
export function scopeTicks(boxes: readonly ScopeBox[], pageText: string, options: { appNames?: readonly string[]; redirectHost?: string } = {}): number[] {
  if (!boxes.length || classifyStuck(pageText) || detectBlocker(pageText) === 'a captcha') return [];
  const lower = pageText.toLowerCase();
  const names = (options.appNames ?? [PLATFORM_APP]).filter(Boolean);
  if (!(names.some(n => lower.includes(n.toLowerCase())) || (!!options.redirectHost && lower.includes(options.redirectHost.toLowerCase())))) return [];
  const scopes = boxes.filter(b => !NOT_A_SCOPE.test(b.name));
  const all = scopes.find(b => SELECT_ALL.test(b.name.trim()));
  if (all) return all.checked && scopes.every(b => b.checked) ? [] : all.checked ? scopes.filter(b => !b.checked).map(b => b.index) : [all.index];
  return scopes.filter(b => !b.checked).map(b => b.index);
}

/** Whether every scope box is ticked (checked after the ticking, before the press). */
export const scopesTicked = (boxes: readonly ScopeBox[]): boolean => boxes.filter(b => !NOT_A_SCOPE.test(b.name)).every(b => b.checked);

/** Sign-in providers on a login page, in the order of preference: Google, then GitHub (a "Last used" mark does not change the order, it only
 * confirms the account is known), then the profile's email, which is typed by the login action, never here. */
const SIGN_IN_PROVIDERS = [/^(?:continue|sign ?(?:in|up)|log ?in)\s+(?:in\s+)?(?:with|using|via)\s+google\b/i, /^(?:continue|sign ?(?:in|up)|log ?in)\s+(?:in\s+)?(?:with|using|via)\s+github\b/i];

export interface PressOptions { email?: string; skipAccount?: boolean; appNames?: readonly string[]; redirectHost?: string }

/** What to press next on a page, as the index into `controls` and why, or undefined when nothing known is on it.
 * An account naming `email` is chosen first (once per address, which the caller tracks by passing `skipAccount`).
 * `consent` is set when the press grants a generically recognized consent screen. */
export function nextPress(host: string, controls: readonly Control[], pageText: string, options: PressOptions = {}): { index: number; note: string; consent?: boolean } | undefined {
  const email = options.email?.trim().toLowerCase();
  if (email && !options.skipAccount) {
    const i = controls.findIndex(c => c.name.toLowerCase().includes(email) && !NOT_CHOOSER.test(c.name));
    if (i >= 0) return { index: i, note: 'Chose the account.' };
  }
  if (classifyStuck(pageText)) return undefined;
  const table = [...(providerFor(host)?.actions ?? []), ...GENERIC_ACTIONS];
  for (const action of table) {
    if (action.when && !action.when.test(pageText)) continue;
    const i = controls.findIndex(c => (action.leaf || !c.leaf) && c.name.length <= 80 && !NEVER.test(c.name) && action.name.test(c.name));
    if (i >= 0) return { index: i, note: action.note, ...(AFFIRMATIVE.test(controls[i]!.name) ? { consent: true } : {}) };
  }
  const read = readConsent(controls, pageText, { ...(options.appNames ? { appNames: options.appNames } : {}), ...(options.redirectHost ? { redirectHost: options.redirectHost } : {}) });
  if (read.consent && read.index !== undefined) return { index: read.index, note: 'Granted access on the consent screen.', consent: true };
  for (const [rank, re] of SIGN_IN_PROVIDERS.entries()) {
    const i = controls.findIndex(c => !c.leaf && re.test(c.name.replace(/\s*last used\s*$/i, '').trim()));
    if (i >= 0) return { index: i, note: rank === 0 ? 'Signed in with Google.' : 'Signed in with GitHub.' };
  }
  return undefined;
}

/** A choice the consent page needs made (organization, account, project): its label and what it offers. */
export interface Selector { label: string; options: readonly string[]; /** the option already chosen, when one is */ selected?: string }

/** What to do about the selectors on a consent page: nothing to choose, a pick of the only option, or a stop listing the options (never a guess). */
export function decideSelectors(selectors: readonly Selector[]): { stop: string } | { choose: { selector: number; option: string }[] } {
  const choose: { selector: number; option: string }[] = [];
  for (const [i, s] of selectors.entries()) {
    if (s.selected) continue;
    if (s.options.length === 1) { choose.push({ selector: i, option: s.options[0]! }); continue; }
    return { stop: `The consent page needs a choice${s.label ? ` ("${s.label}")` : ''} and offers ${s.options.length ? `${s.options.length} options: ${s.options.slice(0, 12).join(' | ')}` : 'none'}. Nothing was pressed; tell me which one to use.` };
  }
  return { choose };
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

/** An error document's own addresses (`type`: https://errors.clikdeploy.com/VALIDATION_ERROR, `instance`) are never an authorization URL. */
const ERROR_ADDRESS = /^https?:\/\/errors\.clikdeploy\.com(?:\/|$)/i;
const URL_KEYS = ['authorizationUrl', 'authorization_url', 'authorizeUrl', 'url'];

function jsonOf(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  try { return JSON.parse(text.slice(start)); } catch { return undefined; }
}

/** Whether the CLI printed an error document (problem+json, or `success: false` / `status: error`), whose URLs are not an answer. */
function isErrorDocument(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.success === false || v.status === 'error' || (typeof v.type === 'string' && ERROR_ADDRESS.test(v.type)) || typeof v.error === 'string' || (typeof v.status === 'number' && v.status >= 400);
}

/** The authorization URL out of whatever `clikdeploy integrations connect --no-browser` prints (JSON or a plain line). An error document has none. */
export function authorizationUrl(text: string): string | undefined {
  const json = jsonOf(text);
  if (json !== undefined) {
    if (isErrorDocument(json)) return undefined;
    const walk = (value: unknown): string | undefined => {
      if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        for (const key of URL_KEYS) { const v = record[key]; if (typeof v === 'string' && /^https?:\/\//.test(v) && !ERROR_ADDRESS.test(v)) return v; }
        for (const v of Object.values(record)) { const found = walk(v); if (found) return found; }
      }
      return undefined;
    };
    const found = walk(json);
    if (found) return found;
  }
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>]+/g)) { const url = m[0].replace(/[.,;)]+$/, ''); if (!ERROR_ADDRESS.test(url)) return url; }
  return undefined;
}

/** Why ClikDeploy would not start the connection, in its own words: the error document's message (or detail), else the last lines printed. */
export function startFailure(text: string): string {
  const json = jsonOf(text) as Record<string, unknown> | undefined;
  const pick = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.split('\n')[0]!.trim() : undefined);
  const said = json && typeof json === 'object' ? pick(json.message) ?? pick(json.detail) ?? pick(json.error) ?? pick(json.title) : undefined;
  return said ?? text.trim().split('\n').slice(-3).join(' ').slice(0, 200);
}

export interface ConnectStart { url: string; stop: () => void }
export interface OAuthConsentOptions {
  /** The state directory: where a payment-class stop is recorded in the human work queue (absent: not recorded). */ stateDir?: string;
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
        const said = startFailure(text);
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
  return page.evaluate(({ pressable, otherApp }) => {
    const leavesPage = new RegExp(otherApp, 'i');
    const out: { name: string; leaf: boolean }[] = [];
    const seen = new Set<string>();
    const doc = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<Record<string, unknown>> } }).document;
    const all = Array.from(doc.querySelectorAll(`${pressable}, span, div, p, li, label`)).slice(0, 1500) as unknown as Array<{ matches(s: string): boolean; getClientRects(): { length: number }; children: { length: number }; textContent: string | null; getAttribute(n: string): string | null; closest(s: string): { getAttribute(n: string): string | null } | null; value?: string }>;
    for (const n of all) {
      if (!n.getClientRects().length) continue;
      // Not on, or inside, a link that opens another program: pressing it would never change the page.
      if (leavesPage.test(n.closest('a[href]')?.getAttribute('href') ?? '')) continue;
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
  }, { pressable: PRESSABLE, otherApp: OPENS_ANOTHER_APP.source });
}


const PLACEHOLDER = /^(?:select|choose|pick|-+|—|–)\b|^$/i;

/** Reads the choices a consent page asks for (native selects and listbox comboboxes). A combobox is opened to read its options, then closed. */
async function readSelectors(page: Page): Promise<Selector[]> {
  const found: Selector[] = [];
  const natives = await page.evaluate(() => {
    const doc = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<Record<string, any>> } }).document;
    return Array.from(doc.querySelectorAll('select')).filter(n => n.getClientRects().length).map(n => {
      const label = (n.getAttribute('aria-label') || n.labels?.[0]?.textContent || '').replace(/\s+/g, ' ').trim();
      const options = Array.from(n.options as ArrayLike<Record<string, any>>).map(o => ({ text: String(o.textContent ?? '').replace(/\s+/g, ' ').trim(), value: String(o.value ?? ''), selected: !!o.selected, disabled: !!o.disabled }));
      return { label, options };
    });
  }).catch(() => []);
  for (const n of natives) {
    const real = n.options.filter(o => o.value !== '' && !o.disabled && !PLACEHOLDER.test(o.text));
    const chosen = n.options.find(o => o.selected && o.value !== '' && !PLACEHOLDER.test(o.text));
    found.push({ label: n.label, options: real.map(o => o.text), ...(chosen ? { selected: chosen.text } : {}) });
  }
  const boxes = page.locator('[role=combobox]:visible, button[aria-haspopup=listbox]:visible');
  const count = Math.min(await boxes.count().catch(() => 0), 4);
  for (let i = 0; i < count; i++) {
    const box = boxes.nth(i);
    const shown = ((await box.innerText({ timeout: 1_000 }).catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    const label = ((await box.getAttribute('aria-label').catch(() => '')) || '').trim();
    if (shown && !PLACEHOLDER.test(shown)) { found.push({ label, options: [shown], selected: shown }); continue; }
    await box.click({ timeout: 2_000 }).catch(quiet('agent/computer/oauth-consent'));
    const options = (await page.locator('[role=option]:visible').allInnerTexts().catch(() => [] as string[])).map(t => t.replace(/\s+/g, ' ').trim()).filter(t => t && !PLACEHOLDER.test(t));
    await page.keyboard.press('Escape').catch(quiet('agent/computer/oauth-consent'));
    found.push({ label: label || shown, options });
  }
  return found;
}

/** Makes the only available choice on a consent page, or returns why it cannot (several options: never a guess). */
async function settleSelectors(page: Page): Promise<string | undefined> {
  const selectors = await readSelectors(page);
  const plan = decideSelectors(selectors);
  if ('stop' in plan) return plan.stop;
  for (const { selector, option } of plan.choose) {
    const native = page.locator('select:visible');
    const n = await native.count().catch(() => 0);
    if (selector < n) { await native.nth(selector).selectOption({ label: option }).catch(quiet('agent/computer/oauth-consent')); continue; }
    const boxes = page.locator('[role=combobox]:visible, button[aria-haspopup=listbox]:visible');
    await boxes.nth(selector - n).click({ timeout: 2_000 }).catch(quiet('agent/computer/oauth-consent'));
    await page.getByRole('option', { name: option }).first().click({ timeout: 2_000 }).catch(quiet('agent/computer/oauth-consent'));
  }
  return undefined;
}

const BOXES = 'input[type=checkbox], [role=checkbox]';

async function readScopeBoxes(page: Page): Promise<ScopeBox[]> {
  return page.evaluate((selector) => {
    const doc = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<Record<string, any>> } }).document;
    const out: { index: number; name: string; checked: boolean }[] = [];
    Array.from(doc.querySelectorAll(selector)).forEach((n, index) => {
      const holder = n.closest?.('label') ?? n.parentElement;
      if (!n.getClientRects().length && !holder?.getClientRects().length) return;
      const text = String(n.getAttribute('aria-label') || n.labels?.[0]?.textContent || holder?.textContent || n.parentElement?.parentElement?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      out.push({ index, name: text, checked: n.checked === true || n.getAttribute('aria-checked') === 'true' });
    });
    return out;
  }, BOXES);
}

/** Ticks the scope boxes a consent page shows (if it is a recognized consent page), then reads them again and returns why one is still unticked. */
async function tickScopes(page: Page, text: string, options: { redirectHost?: string }): Promise<{ ticked: number } | { stop: string }> {
  const boxes = await readScopeBoxes(page).catch(() => [] as ScopeBox[]);
  const plan = scopeTicks(boxes, text, options);
  if (!plan.length) return { ticked: 0 };
  for (const index of plan) {
    const box = page.locator(BOXES).nth(index);
    const done = await box.click({ timeout: 2_000, force: true }).then(() => true, () => false);
    if (!done) await box.evaluate(n => (n as unknown as { click(): void }).click()).catch(quiet('agent/computer/oauth-consent'));
  }
  await page.waitForTimeout(300).catch(quiet('agent/computer/oauth-consent'));
  const after = await readScopeBoxes(page).catch(() => [] as ScopeBox[]);
  const left = after.filter(b => !b.checked && !NOT_A_SCOPE.test(b.name));
  // Google's "Select all" ticks the rest itself; a rest that stayed unticked gets its own press.
  for (const b of left.filter(b => !SELECT_ALL.test(b.name.trim()))) await page.locator(BOXES).nth(b.index).click({ timeout: 2_000, force: true }).catch(quiet('agent/computer/oauth-consent'));
  const final = left.length ? await readScopeBoxes(page).catch(() => [] as ScopeBox[]) : after;
  if (!scopesTicked(final)) return { stop: `The consent page has scope checkboxes that would not tick (${final.filter(b => !b.checked).map(b => b.name).slice(0, 6).join(' | ')}). Nothing was pressed.` };
  return { ticked: plan.length };
}

async function press(page: Page, control: Control): Promise<boolean> {
  const exact = control.name;
  const candidates = control.leaf ? [page.getByText(exact, { exact: true })] : [page.getByRole('button', { name: exact, exact: true }), page.getByRole('link', { name: exact, exact: true }), page.locator(PRESSABLE).filter({ hasText: exact }), page.getByText(exact, { exact: true })];
  for (const base of candidates) {
    const shown = base.filter({ visible: true });
    const count = await shown.count().catch(() => 0);
    // The same words can sit on a link that opens another program (an email address as text): never that one.
    for (let i = 0; i < Math.min(count, 8); i++) {
      const one = shown.nth(i);
      const away = await one.evaluate((node, otherApp) => new RegExp(otherApp, 'i').test((node as unknown as { closest(s: string): { getAttribute(n: string): string | null } | null }).closest('a[href]')?.getAttribute('href') ?? ''), OPENS_ANOTHER_APP.source).catch(() => false);
      if (away) continue;
      if (await one.click({ timeout: 3_000 }).then(() => true, () => false)) return true;
      break;
    }
  }
  return false;
}

/** What a stuck page is, from its own words (and a JSON error body's): the plain label and, when a person must act, the work-queue reason. */
export interface StuckKind { kind: 'unrecognized-client' | 'payment' | 'captcha' | 'mfa'; label: string; reason?: TaskReason }

const UNRECOGNIZED_CLIENT = /unrecogni[sz]ed[\s_-]*client|unknown[\s_-]*client|invalid[_\s-]*client|client[_\s-]*id[^.\n]{0,40}(?:not found|invalid|unknown|unrecogni|does not exist)|no such (?:oauth )?(?:client|app)|(?:oauth )?(?:client|app) (?:not found|does not exist|is not registered)/i;
const NO_CREDITS = /\bno (?:api )?credits?\b|(?:add|buy|purchase|top up) (?:more )?credits?|out of credits|insufficient (?:credits?|funds|balance)|payment required|credit balance|billing|add (?:a )?payment method|upgrade (?:your )?(?:plan|account)\b|card number|\bsubscribe\b.{0,40}\bto continue/i;

export function classifyStuck(pageText: string): StuckKind | undefined {
  if (UNRECOGNIZED_CLIENT.test(pageText)) return { kind: 'unrecognized-client', label: 'the vendor does not recognize the OAuth client (its app registration is missing or wrong; register the app by hand)' };
  if (NO_CREDITS.test(pageText)) return { kind: 'payment', label: 'the vendor wants payment, credits or a plan before it will continue', reason: 'payment' };
  const blocker = detectBlocker(pageText);
  if (blocker === 'a captcha') return { kind: 'captcha', label: 'a captcha' };
  if (blocker === 'an SMS or authenticator code') return { kind: 'mfa', label: 'a verification code (MFA or SMS)' };
  if (blocker === 'a payment page') return { kind: 'payment', label: 'a payment page', reason: 'payment' };
  return undefined;
}

/** The visible page text for a report: whitespace collapsed, long unbroken tokens masked, held secrets scrubbed, cut to `max`. */
export function pageExcerpt(text: string, max = 300): string {
  return scrubSecrets(text).replace(/\s+/g, ' ').replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]').replace(/[A-Za-z0-9_\-.~+/=]{32,}/g, '[token]').trim().slice(0, max);
}

/** A JSON error body the page is showing (an API's `{"message": ...}` or `{"error": ...}`), or undefined. */
export function jsonErrorBody(text: string): string | undefined {
  const t = text.trim();
  if (!t.startsWith('{')) return undefined;
  try {
    const v = JSON.parse(t) as Record<string, unknown>;
    if (!v || typeof v !== 'object' || !('message' in v || 'error' in v || 'error_description' in v || 'errors' in v)) return undefined;
    return pageExcerpt(t);
  } catch { return undefined; }
}

/** Where the browser is when consent stalls: the address (no query), the names of what can be pressed (never an address or a field value),
 * what the page says (about 300 characters of its text, or its JSON error body) and a classification when the words are plain. */
function stuckOn(page: Page, controls: readonly Control[], pageText = ''): string {
  try {
    const url = new URL(page.url());
    const names = [...new Set(controls.filter(c => !c.leaf && !c.name.includes('@')).map(c => c.name))].slice(0, 10);
    const json = jsonErrorBody(pageText);
    const excerpt = json ?? pageExcerpt(pageText);
    const kind = classifyStuck(pageText);
    return `The browser is on ${url.host}${url.pathname}; it shows: ${scrubSecrets(names.join(' | ')) || 'nothing to press'}.${excerpt ? ` Page ${json ? 'JSON error' : 'text'}: "${excerpt}".` : ''}${kind ? ` This looks like ${kind.label}.` : ''}`;
  } catch { return ''; }
}

/** A reason consent stopped. `reason` is set when a person must act and the work queue has a name for it. */
export class ConsentStop extends Error { constructor(message: string, readonly reason?: TaskReason, readonly detail?: StopDetail) { super(message); this.name = 'ConsentStop'; } }

/** Where consent stopped, as data (for a runner that records or hands it on): what the page is, never a field value. */
export interface StopDetail {
  kind: StuckKind['kind'] | 'password' | 'choice' | 'unknown';
  /** The address without its query. */ url: string;
  /** About 300 characters of the page's text, masked. */ pageText: string;
  /** The names of what can be pressed. */ controls: string[];
}

/** The stop as data. */
export function stopDetail(page: Page, controls: readonly Control[], pageText: string, kind?: StopDetail['kind']): StopDetail {
  let url = '';
  try { const u = new URL(page.url()); url = `${u.origin}${u.pathname}`; } catch { /* no address */ }
  const known = classifyStuck(pageText)?.kind;
  return {
    kind: kind ?? known ?? 'unknown', url, pageText: jsonErrorBody(pageText) ?? pageExcerpt(pageText),
    controls: [...new Set(controls.filter(c => !c.leaf && !c.name.includes('@')).map(c => scrubSecrets(c.name)))].slice(0, 12),
  };
}

/** Connects `connector` for the signed-in ClikDeploy account by driving its OAuth consent in `page`. */
export async function oauthConnect(connector: string, page: Page, options: OAuthConsentOptions = {}): Promise<{ connector: string; steps: string[] }> {
  try {
    return await driveConsent(connector, page, options);
  } catch (error) {
    // A vendor that wants payment or credits is a person's act: put it on the human queue with the reason, then report it.
    if (error instanceof ConsentStop && error.reason === 'payment' && options.stateDir) {
      const saved = await saveTask(options.stateDir, { vendor: connector, kind: 'oauth-app', status: 'needs-human', reason: 'payment', note: `oauth_connect stopped: ${error.message}`, connectors: [connector] }).then(() => true, () => false);
      if (saved) throw new ConsentStop(`${error.message} Recorded in the human queue as needs-human [payment].`, 'payment', error.detail);
    }
    throw error;
  }
}

async function driveConsent(connector: string, page: Page, options: OAuthConsentOptions): Promise<{ connector: string; steps: string[] }> {
  if (!CONNECTOR_ID.test(connector)) throw new Error('oauth_connect needs target: a connector id such as slack or github.');
  const started = await (options.start ?? startViaCli)(connector, options.signal);
  const status = options.status ?? ((id, signal) => connectionState(id, signal));
  const steps: string[] = [];
  try {
    let redirectUri: string | undefined;
    try { redirectUri = new URL(started.url).searchParams.get('redirect_uri') ?? undefined; } catch { redirectUri = undefined; }
    await page.goto(started.url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(quiet('agent/computer/oauth-consent'));
    const deadline = Date.now() + (options.timeoutMs ?? 120_000);
    let idle = 0, stopSeen = 0, chosenOn = '', lastPress = { key: '', at: 0 }, controls: Control[] = [], lastText = '';
    while (Date.now() < deadline) {
      if (options.signal?.aborted) throw new Error('Stopped.');
      if (page.isClosed()) throw new ConsentStop('The browser tab was closed before consent finished.');
      const url = page.url();
      const text = await page.evaluate(() => ((globalThis as unknown as { document: { body?: { innerText?: string } } }).document.body?.innerText ?? '').slice(0, 6000)).catch(() => '');
      lastText = text;
      const at = callbackState(url, redirectUri, text);
      if (at === 'problem') throw new ConsentStop(`The callback page reported a problem instead of a connection (${new URL(url).host}${new URL(url).pathname}). Check the consent was allowed and try again.`);
      if (at === 'connected' || at === 'waiting') {
        // The landing page loads and then ClikDeploy stores the tokens: ask ClikDeploy, not the page.
        let last = '';
        for (let tries = 0; tries < 8; tries++) {
          const state = await status(connector, options.signal);
          if (state.connected) { steps.push('Confirmed: ClikDeploy shows an active connection.'); return { connector, steps }; }
          last = state.reason ?? '';
          await page.waitForTimeout(2_500).catch(quiet('agent/computer/oauth-consent'));
        }
        throw new ConsentStop(`The callback page was reached but ClikDeploy shows no active connection${last ? ` (${scrubSecrets(last)})` : ''}.`);
      }
      const hasPassword = await page.locator('input[type=password]:visible').count().catch(() => 0) > 0;
      const hasCode = await page.locator('input[autocomplete=one-time-code]:visible').count().catch(() => 0) > 0;
      const why = stopReason(text, hasPassword, hasCode);
      controls = await readControls(page).catch(() => []);
      if (why) {
        // Two looks in a row, so a page still settling does not stop it.
        if (++stopSeen >= 2) throw new ConsentStop(`Stopped at ${why}. Nothing was typed. ${stuckOn(page, controls, text)}`, classifyStuck(text)?.reason, stopDetail(page, controls, text, hasPassword ? 'password' : hasCode ? 'mfa' : undefined));
      } else {
        stopSeen = 0;
        const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
        const next = nextPress(options.providerHost ?? host, controls, text, { ...(options.email ? { email: options.email } : {}), skipAccount: chosenOn === url, ...(redirectUri ? { redirectHost: (() => { try { return new URL(redirectUri).host; } catch { return ''; } })() } : {}) });
        const control = next && controls[next.index];
        if (next && control && !(lastPress.key === `${url}|${control.name}` && Date.now() - lastPress.at < 2_500)) {
          if (next.note === 'Chose the account.') chosenOn = url;
          if (next.note !== 'Chose the account.' && next.note !== 'Opened Advanced.' && next.note !== 'Continued past the unverified-app notice.') {
            const redirectHost = (() => { try { return redirectUri ? new URL(redirectUri).host : undefined; } catch { return undefined; } })();
            const ticks = await tickScopes(page, text, redirectHost ? { redirectHost } : {});
            if ('stop' in ticks) throw new ConsentStop(`${ticks.stop} ${stuckOn(page, controls, text)}`);
            if (ticks.ticked) { steps.push('Ticked the scope checkboxes.'); options.progress?.('Ticked the scope checkboxes.\n'); }
          }
          if (next.consent) {
            const blocked = await settleSelectors(page);
            if (blocked) throw new ConsentStop(`${blocked} ${stuckOn(page, controls, text)}`, undefined, stopDetail(page, controls, text, 'choice'));
          }
          if (await press(page, control)) {
            lastPress = { key: `${url}|${control.name}`, at: Date.now() };
            steps.push(next.note); options.progress?.(`${next.note}\n`);
            idle = 0;
          }
        } else {
          // A page whose words are plain (unknown client, no credits) offers nothing to press: stop soon, do not wait out the clock.
          const kind = classifyStuck(text);
          if (++idle >= (kind ? 3 : 15)) throw new ConsentStop(`Stopped at ${kind ? kind.label : 'a screen it does not recognize'}. ${stuckOn(page, controls, text)}`, kind?.reason, stopDetail(page, controls, text));
        }
      }
      await page.waitForTimeout(700).catch(quiet('agent/computer/oauth-consent'));
    }
    { const kind = classifyStuck(lastText); throw new ConsentStop(`Consent did not finish in time. ${stuckOn(page, controls, lastText)}`, kind?.reason, stopDetail(page, controls, lastText)); }
  } finally { started.stop(); }
}
