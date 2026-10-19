/** Page-level browser actions in ClikCode's own Chrome profile. */
import { defineTool } from '../tool-contract.js';
import { adoptPage, closeComputerPage, computerPage, openComputerPage } from '../computer/browser.js';
import { COMPUTER_OFF, computerEnabled } from '../computer/settings.js';
import { MAX_TOOL_IMAGE_BYTES, sniffImage } from '../images.js';
import { maskSensitive, sensitiveValues } from '../computer/sensitive-fields.js';
import { storeSecretTool } from './store-secret.js';
import { sharedState } from '../computer/shared-state.js';
import { savedLoginFields, savedLoginsForSite } from '../computer/credential-vault.js';
import { loginValueFor } from '../computer/login-fill.js';
import { addSiteNote, readSiteNotes } from '../computer/site-notes.js';
import { assertCustomKey, customFieldFor, describeProfile, listProfiles, PROFILE_KEYS, phoneFor, profileKeyFor, saveProfile, type FieldHint, type ProfileKey } from '../computer/profiles.js';
import { expectSignup, settleSignup } from '../computer/signup-login.js';
import { loginComputerPage, loginOutcomeMessage } from '../computer/login-page.js';
import { LoginError } from '../computer/login-error.js';
import { type LoginField } from '../computer/login-fields.js';
import { registerSecret, scrubSecrets, showsSecret } from '../computer/secret-scrubber.js';
import { hideKeyLikeText } from '../computer/secret-finder.js';
import { dialogNote, withDialogs } from '../computer/page-dialogs.js';
import { SEND_TO_HELP, SEND_TO_SCHEMA } from './store-secret.js';
import { destinationProblem, normalizeSendTo, type Destination } from '../computer/secret-destinations.js';
import { captureSecret } from '../computer/secret-capture.js';
import { runTailnetHandoff, tailnetAddress } from '../computer/tailnet-handoff.js';
import type { Locator, Page } from 'playwright-core';
import type { ToolContext, ToolRunResult } from '../tool-contract.js';

type Step = { do: 'click' | 'fill' | 'choose' | 'press' | 'scroll' | 'wait'; target?: string; text?: string; key?: string; direction?: 'up' | 'down'; accept_dialog?: boolean; gone?: boolean; seconds?: number };
type WebArgs = {
  action: 'open' | 'close' | 'observe' | 'click' | 'fill' | 'choose' | 'press' | 'scroll' | 'wait' | 'steps' | 'login' | 'handoff' | 'capture_secret' | 'send_secret' | 'profile' | 'open_email_link' | 'read_email_code' | 'notes' | 'help';
  tab?: string; url?: string; host?: string; note?: string; target?: string; text?: string; key?: string; direction?: 'up' | 'down'; steps?: Step[] | string; full?: boolean; find?: string; gone?: boolean; seconds?: number; accept_dialog?: boolean;
  new_account?: boolean; secret?: string; to?: string; with?: Record<string, string> | string; ask?: boolean; from?: string; subject?: string; link?: string; account?: number; fields?: Record<string, string>; ask_fields?: Array<{ key: string; label: string; match?: string[]; optional?: boolean }>; custom?: Record<string, { label?: string; value: string; match?: string[] }>; label?: string; secret_name?: string; paste?: boolean; send_to?: Destination[] | Destination | string;
};

export function webAddress(value: string | undefined): string {
  if (!value) throw new Error('Open needs a website URL.');
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Open needs an HTTP or HTTPS website URL without credentials.');
  return parsed.href;
}

const REF = /^(?:f\d+)?e\d+$/;

/** What `target` points at: a [ref=eN] from the last view (any element, named or not, in any frame),
 * or visible text for the controls of a sign-in page, which are listed by name without references. */
async function locate(page: Page, target: string | undefined): Promise<Locator> {
  const wanted = target?.trim();
  if (!wanted) throw new Error('Say what to act on: a [ref=…] from the page view, or its visible text.');
  if (REF.test(wanted)) {
    const byRef = page.locator(`aria-ref=${wanted}`);
    if (await byRef.count()) return byRef;
    throw new Error(`Nothing on the page has the reference ${wanted}: the page has changed since it was read.`);
  }
  // A field's label names the field, so the field is found before the label's text.
  for (const candidate of [page.getByLabel(wanted, { exact: true }), page.getByPlaceholder(wanted, { exact: true }), page.getByText(wanted, { exact: true }), page.getByTitle(wanted, { exact: true })]) {
    const visible = candidate.locator('visible=true');
    if (await visible.count()) return visible.first();
  }
  // A field's label can include its options ("Plan Free Pro"): a near match on the label is still that field.
  for (const candidate of [page.getByLabel(wanted), page.getByPlaceholder(wanted)]) {
    const visible = candidate.locator('visible=true');
    if (await visible.count() === 1) return visible.first();
  }
  throw new Error(`Nothing on the page shows "${wanted}".`);
}

/** Radios, checkboxes and switches are often visually hidden behind a styled label, and a
 * click can land on something in front: fall back to clicking the element itself. */
async function press(target: Locator): Promise<void> {
  // A checkbox or radio is toggled on the element itself: a pointer click at its centre can land on a link in
  // its label ("I agree to the Terms and Privacy Policy") and open that page instead.
  const toggle = await target.evaluate(node => { const input = node as unknown as { tagName: string; type?: string }; return input.tagName === 'INPUT' && (input.type === 'checkbox' || input.type === 'radio'); }, undefined, { timeout: 2_000 }).catch(() => false);
  if (toggle) { await target.evaluate(node => (node as unknown as { click(): void }).click(), undefined, { timeout: 3_000 }); return; }
  try { await target.click({ timeout: 6_000 }); }
  catch (error) {
    if (!(error instanceof Error) || !/timeout/i.test(error.message)) throw error;
    await target.evaluate(node => (node as unknown as { click(): void }).click(), undefined, { timeout: 3_000 });
  }
}

/** Runs in the page: the visible text and every input value, for the secret check. */
function visibleText(): string {
  const doc = (globalThis as unknown as { document: { body: { innerText: string }; querySelectorAll(selector: string): ArrayLike<{ value?: string }> } }).document;
  return `${doc.body.innerText}\n${Array.from(doc.querySelectorAll('input, textarea')).map(element => element.value ?? '').join('\n')}`;
}

const indentOf = (line: string): number => line.length - line.trimStart().length;
const BEHIND_DIALOG_LINES = 40;
const OVERLAY = /^\s*- (?:dialog|alertdialog|menu|listbox)\b/;
const EDGE = /^\s*- (?:banner|contentinfo)\b/;
/** A site's own side menu: dozens of links that change nothing about the task. Short ones (a breadcrumb) stay. */
const SIDE_MENU = /^\s*- (?:navigation|complementary)\b/;
const LONG_MENU_LINES = 25;

/** The page as read for the agent: what is open comes first (a role dialog or a dropdown is the
 * thing being acted on, and sits at the END of a big page, where a cut-off would lose it), a
 * page's header and footer menus are folded to a line, and a very long middle is trimmed.
 * `full` keeps the header, footer and side menus and allows a longer view. */
/** A dropdown with hundreds of options (a country list) costs a page of text and says nothing: keep the chosen one and the first few, and count the rest. */
export function collapseOptions(snapshot: string, keep = 6): string {
  const lines = snapshot.split('\n');
  const out: string[] = [];
  for (let at = 0; at < lines.length;) {
    if (!/^\s*- option "/.test(lines[at]!)) { out.push(lines[at]!); at++; continue; }
    let end = at;
    while (end < lines.length && /^\s*- option "/.test(lines[end]!) && indentOf(lines[end]!) === indentOf(lines[at]!)) end++;
    const run = lines.slice(at, end);
    if (run.length <= keep + 1) { out.push(...run); at = end; continue; }
    const chosen = run.filter(line => /\[selected\]/.test(line));
    const shown = new Set([...run.slice(0, keep), ...chosen]);
    out.push(...run.filter(line => shown.has(line)), `${' '.repeat(indentOf(run[0]!))}- (… ${run.length - shown.size} more options; choose one by its text)`);
    at = end;
  }
  return out.join('\n');
}

export function arrangeSnapshot(snapshot: string, full = false): string {
  snapshot = collapseOptions(snapshot);
  const lines = snapshot.split('\n');
  const end = (from: number): number => { let at = from + 1; while (at < lines.length && indentOf(lines[at]!) > indentOf(lines[from]!)) at++; return at; };
  const hasMain = lines.some(line => /^\s*- main\b/.test(line));
  const kept: string[] = [];
  const overlays: string[] = [];
  let folded = false;
  for (let at = 0; at < lines.length;) {
    const line = lines[at]!;
    if (OVERLAY.test(line)) { const to = end(at); const base = indentOf(line); overlays.push(...lines.slice(at, to).map(item => item.slice(base))); at = to; continue; }
    if (!full && hasMain && (EDGE.test(line) || (SIDE_MENU.test(line) && end(at) - at > LONG_MENU_LINES))) { folded = true; at = end(at); continue; }
    kept.push(line); at++;
  }
  const cap = full ? 40_000 : 14_000;
  let body = kept.join('\n');
  // A dialog is the thing to act on: the page behind it is a few lines of context, not a second copy of the site.
  if (!full && overlays.length && kept.length > BEHIND_DIALOG_LINES) {
    body = [...kept.slice(0, BEHIND_DIALOG_LINES), `- (… ${kept.length - BEHIND_DIALOG_LINES} more lines of the page behind the dialog; observe with full: true to see them)`].join('\n');
  }
  if (body.length > cap) {
    const rows = body.split('\n');
    let head = 0; let headSize = 0;
    while (head < rows.length && headSize < cap * 0.65) headSize += rows[head++]!.length + 1;
    let tail = rows.length; let tailSize = 0;
    while (tail > head && tailSize < cap * 0.35) tailSize += rows[--tail]!.length + 1;
    body = [...rows.slice(0, head), `- (… ${tail - head} lines trimmed from the middle of a long page; scroll, or observe with full: true …)`, ...rows.slice(tail)].join('\n');
  }
  return [overlays.length ? `Open now (dialogs and menus):\n${overlays.join('\n')}\n` : '', body, folded ? '- (header, footer and long side menus folded away; observe with full: true to see them)' : ''].filter(Boolean).join('\n');
}

/** Only the lines that mention `text`, each under the lines that contain it: for a page too long to read whole. */
export function findInSnapshot(snapshot: string, text: string): string {
  const lines = snapshot.split('\n');
  const wanted = text.toLowerCase();
  const keep = new Set<number>();
  lines.forEach((line, at) => {
    if (!line.toLowerCase().includes(wanted)) return;
    keep.add(at);
    let depth = indentOf(line);
    for (let up = at - 1; up >= 0 && depth > 0; up--) if (indentOf(lines[up]!) < depth) { keep.add(up); depth = indentOf(lines[up]!); }
  });
  return [...keep].sort((a, b) => a - b).map(at => lines[at]!).join('\n');
}

/** A page address for the agent to read: a long query value or fragment (an emailed token, an OAuth code) is shortened, so it neither costs a page of text nor puts a one-use secret in the chat. */
export function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const [key, value] of [...parsed.searchParams.entries()]) if (value.length > 40 || /^(?:code|token|access_token|id_token|state|key|secret)$/i.test(key)) parsed.searchParams.set(key, '…');
    if (parsed.hash.length > 40) parsed.hash = '#…';
    return parsed.href.replace(/%E2%80%A6/g, '…');
  } catch { return url.slice(0, 200); }
}

const lastSeen = sharedState('page-last-seen', () => new WeakMap<Page, { url: string; shown: string }>());

/** What is new on the page since it was last shown, each new line under the lines that contain it.
 * Undefined when most of the page changed (a different page), so the whole page should be shown instead. */
export function changedLines(previous: string, shown: string): { text: string; count: number } | undefined {
  const before = new Set(previous.split('\n').map(line => line.trim()));
  const lines = shown.split('\n');
  const keep = new Set<number>();
  let count = 0;
  lines.forEach((line, at) => {
    if (before.has(line.trim())) return;
    count++;
    keep.add(at);
    let depth = indentOf(line);
    for (let up = at - 1; up >= 0 && depth > 0; up--) if (indentOf(lines[up]!) < depth) { keep.add(up); depth = indentOf(lines[up]!); }
  });
  if (count > lines.length * 0.4 && count > 12) return undefined;
  return { text: [...keep].sort((a, b) => a - b).map(at => lines[at]!).join('\n'), count };
}

/** `compact`: after an action, show only what changed (plus any open dialog) instead of the whole page again. */
export async function observeComputerPage(page: Page, acceptsImages: boolean, full = false, find?: string, compact = false): Promise<ToolRunResult> {
  const raw = scrubSecrets(await maskSensitive(page, await page.ariaSnapshot({ mode: 'ai', timeout: 10_000 } as never) as string));
  // A key the page is showing is not for the model to read: capture_secret takes it.
  const { text: shown, hidden } = hideKeyLikeText(raw.replace(/^(\s*- \/url: )(\S{160})\S+$/gm, '$1$2…'));
  if (find?.trim()) {
    const found = findInSnapshot(shown, find.trim());
    return { output: `Page: ${displayUrl(page.url())}\n\n${found ? `Lines mentioning "${find.trim()}" (with the elements around them):\n${found.slice(0, 12_000)}` : `Nothing on the page mentions "${find.trim()}". Try observe with full: true.`}` };
  }
  const before = lastSeen.get(page);
  lastSeen.set(page, { url: page.url(), shown });
  if (compact && !full && before && before.url === page.url()) {
    const changed = changedLines(before.shown, shown);
    if (changed) {
      const head = arrangeSnapshot(shown, false).split('\n\n')[0]!;
      const open = head.startsWith('Open now') ? `${head}\n\n` : '';
      const body = changed.count ? `Changed on the page (${changed.count} new or changed line${changed.count === 1 ? '' : 's'}; the rest is as before, observe for the whole page):\n${changed.text.slice(0, 8_000)}` : 'Nothing on the page changed (observe for the whole page).';
      return { output: `Page: ${displayUrl(page.url())}\n\n${open}${body}${hidden ? `\n\n[${hidden} key-like value${hidden === 1 ? '' : 's'} hidden. Use capture_secret to save it without reading it.]` : ''}` };
    }
  }
  const snapshot = arrangeSnapshot(shown, full);
  const output = `Page: ${displayUrl(page.url())}\n\n${snapshot}${hidden ? `\n\n[${hidden} key-like value${hidden === 1 ? '' : 's'} hidden. Use capture_secret to save it without reading it.]` : ''}`;
  if (!acceptsImages) return { output };
  if (hidden || (await sensitiveValues(page)).length || showsSecret(snapshot) || showsSecret(await page.evaluate(visibleText).catch(() => ''))) return { output: `${output}\n\n[Screenshot withheld: the page holds a typed credential or a saved secret.]` };
  let bytes = await page.screenshot({ type: 'jpeg', quality: 65, animations: 'disabled', timeout: 10_000 });
  if (bytes.length > MAX_TOOL_IMAGE_BYTES) bytes = await page.screenshot({ type: 'jpeg', quality: 35, animations: 'disabled', timeout: 10_000 });
  const found = sniffImage(bytes);
  if (!found || bytes.length > MAX_TOOL_IMAGE_BYTES) return { output: `${output}\n\n[Screenshot too large to show.]` };
  return { output, images: [{ mimeType: found.mimeType, data: bytes.toString('base64') }] };
}

/** Wait for what an action started to land, so the view that follows is a finished page, not a spinner. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => undefined);
  // Quiet, not "network idle" (many sites never go idle): done once the page has stopped changing for a moment.
  await page.evaluate(() => new Promise<void>(resolve => {
    const g = globalThis as unknown as { document: object; MutationObserver: new (callback: () => void) => { observe(target: object, options: object): void; disconnect(): void }; setTimeout(callback: () => void, ms: number): number; clearTimeout(id: number): void };
    let quiet = g.setTimeout(done, 250);
    const watcher = new g.MutationObserver(() => { g.clearTimeout(quiet); quiet = g.setTimeout(done, 250); });
    watcher.observe(g.document, { subtree: true, childList: true, attributes: true, characterData: true });
    g.setTimeout(done, 1_500);
    function done(): void { watcher.disconnect(); resolve(); }
  })).catch(() => undefined); // a navigation destroys the page being watched: the next look is a new page
}

const ACTION_LIST = 'open · close · observe · click · fill · choose · press · scroll · wait · steps · login · handoff · capture_secret · send_secret · profile · open_email_link · read_email_code · notes · help';

const WEB_PARAMETERS = { type: 'object', additionalProperties: true, required: ['action'], properties: {
    action: { type: 'string', description: ACTION_LIST },
    tab: { type: 'string', description: 'Name of your own tab. Agents working in parallel each pass a different name on every call, so they never share, read or navigate each other\'s page. Leave out when you are the only one using the browser.' },
    url: { type: 'string', description: 'open: the website address.' },
    host: { type: 'string', description: 'notes: the site (default: the open page\'s).' },
    note: { type: 'string', description: 'notes: a step, address or gotcha worth knowing the next time this task is done on the site. Leave out to read the saved notes. Never a key or password.' },
    target: { type: 'string', description: 'click, fill, capture_secret: a [ref=…] from the page view (e5, or f1e2 inside a frame), or the visible text of a sign-in page control.' },
    text: { type: 'string', description: 'fill: the text. Leave it out for what only the user knows (name, address, phone, a password): the user is asked privately, once for all such fields in the call, and you are not shown the answer. wait: the words to wait for.' },
    gone: { type: 'boolean', description: 'wait: wait for the text to disappear instead of appear.' },
    seconds: { type: 'number', description: 'wait: how long to wait at most (default 30, up to 120).' },
    find: { type: 'string', description: 'observe: show only the lines that mention these words.' },
    key: { type: 'string', description: 'press: a key such as Enter or Escape.' },
    direction: { type: 'string', enum: ['up', 'down'], description: 'scroll.' },
    steps: { type: ['array', 'string'], description: 'steps: what to do, in order, e.g. [{do:"fill", target:"e4", text:"My key"}, {do:"click", target:"e9"}].',
      items: { type: 'object', additionalProperties: false, required: ['do'], properties: {
        do: { type: 'string', enum: ['click', 'fill', 'choose', 'press', 'scroll', 'wait'] }, target: { type: 'string' }, text: { type: 'string' }, key: { type: 'string' }, direction: { type: 'string', enum: ['up', 'down'] }, accept_dialog: { type: 'boolean' }, gone: { type: 'boolean' }, seconds: { type: 'number' },
      } } },
    full: { type: 'boolean', description: 'observe: include the header and footer and a longer view.' },
    accept_dialog: { type: 'boolean', description: 'click: answer yes to a browser confirm dialog the click raises ("delete this token?"). Default: declined and reported.' },
    new_account: { type: 'boolean', description: 'login: ask for a different account instead of the saved one.' },
    paste: { type: 'boolean', description: 'capture_secret: only when the user has said they will paste it: skip looking and ask them privately. Never use it because capture failed; reveal, copy or rotate the key instead.' },
    secret: { type: 'string', description: 'send_secret: name a key was saved under (send it again, or somewhere else, without seeing it). With to and with, or send_to.' },
    to: { type: 'string', description: 'send_secret: destination name, e.g. clikdeploy-secret.' },
    with: { type: ['object', 'string'], description: 'send_secret: values for the destination slots, e.g. {key:"SALAD_API_KEY"}.' },
    ask: { type: 'boolean', description: 'profile: ask the user now for name, email, phone and address and save them as a profile (also happens when none exists).' },
    from: { type: 'string', description: 'open_email_link, read_email_code: sender (name or address) of the email in the signed-in Gmail.' },
    subject: { type: 'string', description: 'open_email_link, read_email_code: words from the subject.' },
    link: { type: 'string', description: 'open_email_link: words or domain of the link to open (default: the first real link in the message).' },
    account: { type: 'integer', description: 'open_email_link, read_email_code: Gmail account number /u/N (default 0).' },
    fields: { type: 'object', additionalProperties: { type: 'string' }, description: `profile: fields to save or correct in the user's autofill profile (${PROFILE_KEYS.join(', ')}). Leave out to list the profiles. Use it when a site wants a different format (phone as +1…, state as an abbreviation).` },
    label: { type: 'string', description: 'profile: which profile (default: the only one, or a new one called Personal).' },
    ask_fields: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { key: { type: 'string' }, label: { type: 'string' }, match: { type: 'array', items: { type: 'string' } }, optional: { type: 'boolean' } }, required: ['key', 'label'] }, description: 'profile: ask the user, privately and in one prompt, for details a task needs beyond the standard ones, and keep them in a profile (with label, a new one) so every later fill with no text uses them. key is lower_snake_case (app_name, privacy_policy_url); label is what the user is asked; match lists the words a form may label it with (["app name","application name"]); optional fields may be left empty. Details only, never a key or password.' },
    custom: { type: 'object', additionalProperties: { type: 'object', additionalProperties: false, properties: { label: { type: 'string' }, value: { type: 'string' }, match: { type: 'array', items: { type: 'string' } } }, required: ['value'] }, description: 'profile: save custom details you already know (a redirect address, the app name you chose) into a profile, same shape as ask_fields answers: {key: {label, value, match}}.' },
    secret_name: { type: 'string', description: 'capture_secret: name to save the key under (default: the site\'s name plus "/key").' },
    send_to: { ...SEND_TO_SCHEMA, description: 'capture_secret: ' + SEND_TO_HELP },
  } };

const WEB_DESCRIPTION = [
    "Drive ClikCode's own Chrome (its own saved profile; it starts by itself). open and observe return the page, with a [ref=…] on each element: pass a ref as target (or visible text) to click or fill. After an action you get only what changed (and any open dialog); observe shows the whole page again. A new tab or popup the page opens is followed automatically.",
    'Actions: open (a URL) · observe (the page again; full: true adds header and footer; find: "words" shows only the lines that mention them, for a long page) · click · fill · choose (an option of a dropdown: target + text) · press · scroll · wait (for text to appear or go, up to 2 minutes; for jobs that finish on their own) · steps (several of those in order, one call, stops at the first failure) · login · handoff · capture_secret · profile · open_email_link (find the newest email from a sender in the signed-in Gmail and open a link in it, one call: verification and sign-in emails) · notes (read or add what was learned on a site: the URL that worked, the order of screens, what was missing; shown again whenever a page on that host is opened, so write one when a task finally works) · read_email_code (the one-time code in the newest email from a sender, read in a tab of its own, so a sign-up that wants an emailed code does not need the user) · close.',
    'Each chat has its own tab. The user\'s autofill profile (name, email, phone, address, and any custom details you asked for with profile ask_fields) fills forms for you: fill a field with no text and it is filled from the profile, or the user is asked once and the answer is kept. If a site wants another format, fill that field with the exact text, and save the corrected value with action profile and fields. When a site offers Continue/Sign in with Google and the browser is already signed in to Google, prefer it: no new password or email check. Every page can be read, including sign-in and signup forms; the values of password, code and card fields are masked. For anything only the user knows (a password, a code, an address, a phone number), fill the field with no text: a saved login for the site or the profile fills it, else the user is asked privately, and you are not shown the answer. That is all a sign-in or signup needs: fill the fields, click Next, repeat. (login does the same in one action for a plain email-then-password sign-in.) Never ask for a password or code in chat. When a sign-in page offers different ways in (root or IAM, another account), ask the user with ask_user, click their choice, then login. handoff returns a phone link for a CAPTCHA or MFA at once; give it to the user, then call handoff again to wait until they finish.',
    'Work through the whole task you were given without checking in at each step. Ask real choices (project, account, role set) once, up front, in one question; after that ask only when genuinely blocked (a sign-in they must type, a payment).',
    'API keys: go to the key page, set the options, then capture_secret with target = the final Create button and a send_to plan. It presses the site\'s Copy button or reads the file it hands over, checks the key against its service, saves it to ClikCode Secrets Manager and sends it where send_to says. You never see the key. With no target it takes a key the page already shows; never click Regenerate just to see one.',
  ].join('\n');

export const computerWebTool = defineTool<WebArgs>({
  name: 'computer_web', class: 'exec',
  description: WEB_DESCRIPTION,
  // Open on purpose: a chat keeps the argument list it started with, and the reloaded code (hot-tools.ts) understands more.
  parameters: WEB_PARAMETERS,
  label: (args) => {
    const host = (): string => { try { return new URL(args.url ?? '').hostname.replace(/^www\./, ''); } catch { return args.url?.slice(0, 60) ?? ''; } };
    switch (args.action) {
      case 'open': return `Open ${host()}`;
      case 'observe': return 'Look at the page';
      case 'click': return `Click ${args.target ?? ''}`.trim();
      case 'fill': return `Fill ${args.target ?? ''}`.trim();
      case 'press': return `Press ${args.key ?? ''}`.trim();
      case 'wait': return `Wait for ${args.text ? `"${args.text}"` : `${args.seconds ?? 30}s`}`;
      case 'steps': return `${args.steps?.length ?? 0} steps on the page`;
      case 'login': return 'Sign in';
      case 'handoff': return 'Hand off to phone';
      case 'capture_secret': return `Capture key${args.secret_name ? ` as ${args.secret_name}` : ''}`;
      case 'close': return 'Close browser';
      default: return `Web ${args.action}`;
    }
  },
  describe: async (args) => `ClikCode browser: ${args.action}${args.url ? ` ${args.url}` : ''}${args.target ? ` ${args.target}` : ''}${args.action === 'fill' ? ` (${args.text?.length ?? 0} characters)` : ''}`,
  // One chat's browser calls run in the order they were made. The model can send two at once (a capture and
  // the click that closes the dialog it reads), and a one-time key does not survive that race.
  run: (args, ctx) => inOrder(args.tab ? `${ctx.stateDir}#${args.tab}` : ctx.stateDir, async (): Promise<ToolRunResult> => {
    try {
      if (!(await computerEnabled(ctx.stateDir))) throw new Error(COMPUTER_OFF);
      if (args.action === 'help') return { output: `${WEB_DESCRIPTION}\n\nArguments: ${Object.entries((WEB_PARAMETERS as { properties: Record<string, { description?: string }> }).properties).map(([name, spec]) => `${name}${spec.description ? ` (${spec.description})` : ''}`).join('; ')}` };
      if (!ACTION_LIST.split(' · ').includes(String(args.action))) throw new Error(`Unknown action "${String(args.action)}". Actions: ${ACTION_LIST}.`);
      if (args.action === 'send_secret') return storeSecretTool.run({ secret: args.secret ?? '', ...(args.to ? { to: args.to } : {}), ...(args.with ? { with: args.with } : {}), ...(args.send_to ? { send_to: args.send_to } : {}) }, ctx);
      if (args.action === 'profile') {
        const known = args.custom && Object.keys(args.custom).length ? args.custom : undefined;
        if ((args.fields && Object.keys(args.fields).length) || known) return { output: `Saved. ${describeProfile(await saveProfile(ctx.stateDir, { ...(args.label ? { label: args.label } : {}), fields: args.fields ?? {}, ...(known ? { custom: known } : {}) }))}` };
        const all = await listProfiles(ctx.stateDir);
        // Details this task needs that no profile holds yet: one private prompt for them, kept in a profile (the
        // named one, a new one, or the first) so the next fill with no text uses them.
        if (args.ask_fields?.length) {
          if (!ctx.requestPrivateLogin) throw new Error('This chat cannot ask the user privately. Save details you know with custom, or the user can run: clikcode computer profile --custom key=value');
          for (const spec of args.ask_fields) { assertCustomKey(spec.key); if (!spec.label?.trim()) throw new Error(`ask_fields "${spec.key}" needs a label: it is what the user is asked.`); }
          const target = args.label ? all.find(profile => profile.label.toLowerCase() === args.label!.toLowerCase()) : all[0];
          const prompt = args.ask_fields.map((spec, index): LoginField => ({ index, key: spec.key, label: spec.label.trim(), kind: 'text', required: !spec.optional, ...(target?.custom?.[spec.key]?.value ? { current: target.custom[spec.key]!.value } : {}) }));
          const answers = await ctx.requestPrivateLogin('https://profile.clikcode', prompt, ctx.signal);
          if (!answers) throw new Error('The user did not provide the details.');
          const custom = Object.fromEntries(args.ask_fields.filter(spec => (answers[spec.key] ?? '').trim()).map(spec => [spec.key, { label: spec.label, value: answers[spec.key]!, ...(spec.match ? { match: spec.match } : {}) }]));
          return { output: `Saved. ${describeProfile(await saveProfile(ctx.stateDir, { ...(target ? { id: target.id } : { label: args.label?.trim() || 'Custom' }), fields: {}, custom }))}` };
        }
        // Asked for by the agent, or nothing saved yet: one private prompt shows what is saved ("Keep …", or type a
        // replacement) and asks for what is missing; the result is the profile.
        if (args.ask || !all.length) {
          if (!ctx.requestPrivateLogin) throw new Error('This chat cannot ask the user privately. Save a profile with fields, or the user can run: clikcode computer profile --set key=value');
          const current = (args.label ? all.find(profile => profile.label.toLowerCase() === args.label!.toLowerCase()) : all[0])?.fields ?? {};
          const asked = PROFILE_PROMPT.map(([key, label, required], index): LoginField => ({ index, key, label, kind: 'text', required, ...(current[key as ProfileKey] ? { current: current[key as ProfileKey]! } : {}) }));
          const answers = await ctx.requestPrivateLogin('https://profile.clikcode', asked, ctx.signal);
          if (!answers) throw new Error('The user did not provide the profile.');
          return { output: `Saved. ${describeProfile(await saveProfile(ctx.stateDir, { ...(args.label ? { label: args.label } : all[0] ? { id: all[0].id } : {}), fields: answers }))}` };
        }
        return { output: all.map(describeProfile).join('\n') };
      }
      if (args.action === 'close') { await closeComputerPage(ctx.stateDir, args.tab); return { output: 'This chat\'s tab is closed.' }; }
      if (args.action === 'open') webAddress(args.url);
      const page = args.action === 'open' || args.action === 'open_email_link' ? await openComputerPage(ctx.stateDir, args.tab) : await computerPage(ctx.stateDir, args.tab);
      // Playwright cannot be interrupted mid-call, so a stop returns at once
      // and the browser carries on harmlessly in the background.
      let onAbort = (): void => undefined;
      const stopped = new Promise<never>((_resolve, reject) => { onAbort = () => reject(new Error('Stopped.')); });
      stopped.catch(() => undefined);
      ctx.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        if (ctx.signal?.aborted) throw new Error('Stopped.');
        const done = await Promise.race([stopped, act(page, args, ctx)]);
        // The page the batch ended on, which is not `page` when a popup took over.
        return done.isError ? done : withSignInHints(done, await computerPage(ctx.stateDir, args.tab).catch(() => page), ctx.stateDir);
      } finally { ctx.signal?.removeEventListener('abort', onAbort); }
    } catch (error) {
      // A sign-in's own errors may echo what was typed, so only its planned messages are shown; a capture's are always the real reason.
      if (args.action === 'login') return { output: error instanceof LoginError ? error.message : 'Private login did not finish. Check the browser and try again.', isError: true };
      if (args.action === 'capture_secret') {
        const why = error instanceof Error ? error.message : String(error);
        // A click that creates a key at the site cannot be undone from here: say so, or a live key is left behind unnoticed.
        const clicked = (error as { afterClick?: boolean }).afterClick ? ` The click on "${args.target ?? 'the button'}" may already have created a key at the site; if so, delete it there.` : '';
        // The site often says why (an error under the button, "purchase credits"): say it too, instead of only "not found".
        const siteSaid = (error as { afterClick?: boolean }).afterClick ? await pageProblem(await computerPage(ctx.stateDir, args.tab).catch(() => undefined)) : '';
        return { output: scrubSecrets(`${why.startsWith('Not saved') ? why : `Not saved: ${why}`}${siteSaid ? ` The page says: "${siteSaid}".` : ''}${clicked}`), isError: true };
      }
      return { output: error instanceof Error ? error.message : String(error), isError: true };
    }
  }),
});

const queues = sharedState('computer-web-queue', () => new Map<string, Promise<unknown>>());
export function inOrder<T>(key: string, job: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(job, job);
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}

const handoffs = sharedState('handoffs', () => new Map<string, { link: Promise<string>; done: Promise<{ ok: true } | { ok: false; message: string }>; stop: AbortController }>());

const INTERACTIONS: ReadonlySet<string> = new Set(['click', 'fill', 'choose', 'press', 'scroll', 'wait']);

/** What one step did. `halt` means the steps after it must not run: they were written for a page that is not there yet. */
type StepOutcome = string | { note: string; halt: true };

/** Long jobs (an API being enabled, a resource being created) finish on their own: wait for words to
 * appear (or go) instead of looking again and again. Gives up with the page as it is, and says so. */
async function waitOn(page: Page, step: Step): Promise<StepOutcome> {
  const seconds = Math.min(Math.max(Math.floor(step.seconds ?? 30), 1), 120);
  const text = step.text?.trim();
  if (!text) { await page.waitForTimeout(seconds * 1000); return `Waited ${seconds}s.`; }
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const shown = (await page.ariaSnapshot({ mode: 'ai', timeout: 8_000 } as never).catch(() => '') as string).toLowerCase().includes(text.toLowerCase());
    if (shown !== (step.gone === true)) return `${step.gone ? 'Gone' : 'Appeared'}: "${text}".`;
    await page.waitForTimeout(1_000);
  }
  // Not an error: the page simply is not there yet. What it shows now is the answer.
  return { note: `Still ${step.gone ? 'showing' : 'not showing'} "${text}" after ${seconds}s.`, halt: true };
}

/** One thing done to the page, in words. Throws with the reason it could not be done. */
async function doStep(page: Page, step: Step): Promise<StepOutcome> {
  switch (step.do) {
    case 'click': {
      const target = await locate(page, step.target);
      const { dialogs } = await withDialogs(page, step.accept_dialog === true, () => clickOrHint(target));
      return `Clicked ${step.target}.${dialogNote(dialogs, step.accept_dialog === true)}`;
    }
    case 'fill': {
      if (typeof step.text !== 'string' || step.text.length > 20_000) throw new Error('Fill needs text of at most 20,000 characters.');
      const target = await locate(page, step.target);
      // Typing, not setting a value: forms that check each key press (a phone box, an enabled Continue) only see real input.
      const tag = await target.evaluate(element => (element as unknown as { tagName: string }).tagName).catch(() => '');
      if (tag === 'SELECT') { await target.selectOption({ label: step.text }, { timeout: 10_000 }).catch(() => target.selectOption(step.text!, { timeout: 10_000 })); return `Chose "${step.text}" in ${step.target}.`; }
      if (step.text.length <= 200 && tag !== 'TEXTAREA') {
        await target.fill('', { timeout: 10_000 });
        await target.pressSequentially(step.text, { timeout: 10_000 });
        await target.blur().catch(() => undefined);
      } else await target.fill(step.text, { timeout: 10_000 });
      return `Filled ${step.target}.`;
    }
    case 'choose': {
      // A dropdown that is not a <select>: open it, type to narrow the list, take the option that says this.
      if (!step.text) throw new Error('Choose needs the option text.');
      const target = await locate(page, step.target);
      if (await target.evaluate(element => (element as unknown as { tagName: string }).tagName).catch(() => '') === 'SELECT') { await target.selectOption({ label: step.text }, { timeout: 10_000 }); return `Chose "${step.text}".`; }
      await clickOrHint(target);
      await page.keyboard.insertText(step.text).catch(() => undefined);
      await page.waitForTimeout(250);
      const option = page.getByRole('option', { name: step.text, exact: true }).or(page.getByRole('option', { name: new RegExp(step.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') })).first();
      if (await option.count().catch(() => 0)) await option.click({ timeout: 5_000 });
      else await page.keyboard.press('Enter');
      return `Chose "${step.text}".`;
    }
    case 'press':
      if (!step.key || !/^[A-Za-z0-9+_-]{1,30}$/.test(step.key)) throw new Error('Press needs a simple key.');
      await page.keyboard.press(step.key);
      return `Pressed ${step.key}.`;
    case 'scroll':
      await page.mouse.wheel(0, step.direction === 'up' ? -600 : 600);
      return 'Scrolled.';
    case 'wait': return waitOn(page, step);
    default: throw new Error(`Unknown step "${String((step as { do?: unknown }).do)}".`);
  }
}

/** What a form field is, for matching it to a saved profile and for the private prompt. */
async function describeField(target: Locator): Promise<{ label: string; password: boolean; hint: FieldHint; placeholder: string; current: string }> {
  return target.evaluate(element => {
    const el = element as unknown as { type?: string; value?: string; labels?: ArrayLike<{ textContent: string | null }>; getAttribute(name: string): string | null };
    const label = (el.labels?.[0]?.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '').trim();
    const type = el.type ?? 'text';
    return { label, password: type === 'password', placeholder: el.getAttribute('placeholder') ?? '', current: type === 'password' ? '' : el.value ?? '',
      hint: { autocomplete: el.getAttribute('autocomplete') ?? '', type, text: `${label} ${el.getAttribute('name') ?? ''} ${el.getAttribute('id') ?? ''}` } };
  }).catch(() => ({ label: '', password: false, hint: { autocomplete: '', type: 'text', text: '' }, placeholder: '', current: '' }));
}

const PROFILE_PROMPT: readonly [string, string, boolean][] = [['given_name', 'First name', true], ['family_name', 'Last name', true], ['email', 'Email', true], ['phone', 'Phone (with area code)', true], ['address_line1', 'Street address', true], ['address_line2', 'Apartment / suite (optional)', false], ['city', 'City', true], ['state', 'State', true], ['postal_code', 'Zip / postal code', true], ['country', 'Country', true], ['organization', 'Company (optional)', false]];

const profileChoice = sharedState('profile-choice', () => new Map<string, string>());

/** Fills that name no text: a saved profile covers what it can (name, address, phone), the user is asked
 * once, privately, for the rest, and what they answer is kept in the profile for next time. */
async function askForFills(page: Page, steps: readonly Step[], ctx: ToolContext): Promise<Step[]> {
  const blank = steps.filter(step => step.do === 'fill' && step.text === undefined);
  if (!blank.length) return [...steps];
  const origin = new URL(page.url()).origin;
  const fields = await Promise.all(blank.map(async step => ({ step, ...await describeField(await locate(page, step.target)) })));
  const profiles = await listProfiles(ctx.stateDir);
  let profile = profiles.length === 1 ? profiles[0] : undefined;
  if (profiles.length > 1) {
    const remembered = profileChoice.get(`${ctx.stateDir}|${origin}`);
    profile = profiles.find(candidate => candidate.id === remembered);
    const wanted = fields.some(field => { const key = profileKeyFor(field.hint); return (key && profiles.some(candidate => candidate.fields[key])) || profiles.some(candidate => customFieldFor(candidate, field.hint)); });
    if (!profile && wanted && ctx.requestPrivateLogin) {
      const labels = profiles.map(candidate => candidate.label);
      const answer = await ctx.requestPrivateLogin(origin, [{ index: -1, key: 'profile', label: 'Fill this form with which profile?', kind: 'choice', required: true, options: labels }], ctx.signal);
      profile = profiles[labels.indexOf(answer?.profile ?? '')];
      if (profile) profileChoice.set(`${ctx.stateDir}|${origin}`, profile.id);
    }
  }
  const values = new Map<Step, string>();
  const ask: { step: Step; key: ProfileKey | undefined; field: LoginField }[] = [];
  // A saved login for this site fills its sign-in fields. Not on a form that creates a password (two password
  // boxes): that is a signup, and the saved login belongs to the account that already exists.
  let login: Record<string, string> | undefined;
  if (fields.filter(field => field.password).length <= 1) {
    const accounts = (await savedLoginsForSite(ctx.stateDir, page.url()).catch(() => [])).filter(account => !account.rejected);
    if (accounts.length && fields.some(field => loginValueFor({ username: 'x', password: 'x' }, field))) {
      let account = accounts.length === 1 ? accounts[0] : accounts.find(candidate => candidate.id === profileChoice.get(`${ctx.stateDir}|login|${origin}`));
      if (!account && ctx.requestPrivateLogin) {
        const labels = accounts.map(candidate => candidate.label);
        const answer = await ctx.requestPrivateLogin(origin, [{ index: -1, key: 'account', label: 'Sign in with which account?', kind: 'choice', required: true, options: [...labels, 'Enter a different one'] }], ctx.signal);
        account = accounts[labels.indexOf(answer?.account ?? '')];
        if (account) profileChoice.set(`${ctx.stateDir}|login|${origin}`, account.id);
      }
      if (account) login = await savedLoginFields(ctx.stateDir, page.url(), account.id).catch(() => undefined);
    }
  }
  for (const field of fields) {
    const fromLogin = login ? loginValueFor(login, field) : undefined;
    if (fromLogin) { values.set(field.step, fromLogin); continue; }
    // A detail the agent asked for by name ("Support email") is more specific than the standard field its words also suggest.
    const asked = field.password ? undefined : customFieldFor(profile, field.hint);
    if (asked) { values.set(field.step, asked.field.value); continue; }
    const key = field.password ? undefined : profileKeyFor(field.hint);
    const known = key ? profile?.fields[key] : undefined;
    if (known) { values.set(field.step, key === 'phone' ? phoneFor(known, field.placeholder, field.current) : known); continue; }
    ask.push({ step: field.step, key, field: { index: ask.length, key: `fill${ask.length}`, label: field.label || String(field.step.target), kind: field.password ? 'password' : 'text', required: true } });
  }
  if (ask.length) {
    if (!ctx.requestPrivateLogin) throw new Error('Fill needs text: this chat cannot ask the user privately.');
    const answers = await ctx.requestPrivateLogin(origin, ask.map(item => item.field), ctx.signal);
    if (!answers) throw new Error('The user did not provide the values.');
    const learned: Partial<Record<ProfileKey, string>> = {};
    for (const item of ask) {
      const answer = answers[item.field.key] ?? '';
      values.set(item.step, answer);
      // A password typed into a form shows in the page's own text afterwards: hold it back from every view.
      if (item.field.kind === 'password' && answer) { registerSecret(answer); expectSignup(page, answer); }
      else if (item.key && answer) learned[item.key] = answer;
    }
    if (Object.keys(learned).length && (profile || profiles.length === 0)) await saveProfile(ctx.stateDir, { ...(profile ? { id: profile.id } : {}), fields: learned });
  }
  return steps.map(step => values.has(step) ? { ...step, text: values.get(step)! } : step);
}

/** An error or alert the page is showing right now (a line that names an error, failure or a needed payment), for a failure report. */
export async function pageProblem(page: Page | undefined): Promise<string> {
  if (!page) return '';
  try {
    const text = await page.evaluate(() => (globalThis as unknown as { document: { body: { innerText: string } } }).document.body.innerText);
    const line = text.split('\n').map(item => item.trim()).find(item => item.length > 8 && item.length < 200 && /\b(error|failed|failure|unable|invalid|purchase|insufficient|required|not allowed|denied)\b/i.test(item));
    return line ?? '';
  } catch { return ''; }
}

/** Why a form will not go on: fields the browser or the page marks invalid, and a main button that is disabled. */
export async function formProblems(page: Page): Promise<string[]> {
  try {
    return await page.evaluate(() => {
      type El = { getAttribute(name: string): string | null; labels?: ArrayLike<{ textContent: string | null }>; validationMessage?: string; checkValidity?: () => boolean; disabled?: boolean; textContent: string | null; value?: string };
      const doc = (globalThis as unknown as { document: { querySelectorAll(selector: string): ArrayLike<El> } }).document;
      const problems: string[] = [];
      for (const field of Array.from(doc.querySelectorAll('input, select, textarea'))) {
        const invalid = field.getAttribute('aria-invalid') === 'true' || (field.checkValidity && !field.checkValidity() && !!field.value);
        if (!invalid) continue;
        const label = (field.labels?.[0]?.textContent || field.getAttribute('aria-label') || field.getAttribute('placeholder') || field.getAttribute('name') || 'a field').trim().slice(0, 40);
        problems.push(`${label} looks invalid${field.validationMessage ? `: ${field.validationMessage}` : ''}`);
      }
      for (const button of Array.from(doc.querySelectorAll('button'))) {
        const text = (button.textContent ?? '').trim();
        if (button.disabled && /^(continue|next|submit|create|sign up|save|verify|start|register)\b/i.test(text)) problems.push(`the "${text.slice(0, 30)}" button is disabled`);
      }
      return problems.slice(0, 6);
    });
  } catch { return []; }
}

/** Does the steps in order, following a new tab or popup, and returns the page as it ends up. */
async function runSteps(page: Page, steps: readonly Step[], ctx: ToolContext, tab?: string): Promise<ToolRunResult> {
  const notes: string[] = [];
  let current = page;
  steps = await askForFills(page, steps, ctx);
  for (const [index, step] of steps.entries()) {
    // Only a tab the chat's own page opens is followed; another chat's tabs are not this chat's business.
    const popups: Page[] = [];
    const onPopup = (popup: Page): void => { popups.push(popup); };
    current.on('popup', onPopup);
    let halted = false;
    try {
      const done = await doStep(current, step);
      if (typeof done === 'string') notes.push(done); else { notes.push(done.note); halted = true; }
      await settle(current);
      const saved = await settleSignup(ctx.stateDir, current);
      if (saved) notes.push(saved);
    } catch (error) {
      // The page closing itself (a sign-in popup that finished) is read from the page, not from an error message.
      if (current.isClosed()) {
        const live = current.context().pages().filter(item => !item.isClosed()).at(-1);
        if (live) { current = live; adoptPage(ctx.stateDir, current, tab); halted = true; notes.push(`Step ${index + 1} (${step.do}): the tab closed itself, so this is the page that is open now.`); }
      }
      if (!halted) {
        // What changed, not the whole page again: a failed step in a long batch used to repeat thousands of tokens.
        const view = await observeComputerPage(current, false, false, undefined, true).catch(() => undefined);
        return { output: `${[...notes, `Step ${index + 1} (${step.do}${step.target ? ` ${step.target}` : ''}) failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`].join('\n')}${view ? `\n\n${view.output}` : ''}`, isError: true };
      }
    }
    finally { current.off('popup', onPopup); }
    const next = popups.filter(popup => !popup.isClosed()).at(-1);
    if (next) {
      current = next;
      adoptPage(ctx.stateDir, current, tab);
      await settle(current);
      notes.push(`A new tab opened and is now the page: ${displayUrl(current.url())}`);
    }
    if (halted) {
      const rest = steps.length - index - 1;
      if (rest > 0) notes.push(`${rest} later step${rest === 1 ? ' was' : 's were'} not run.`);
      break;
    }
  }
  const view = await observeComputerPage(current, false, false, undefined, true);
  const problems = steps.some(step => step.do === 'fill' || step.do === 'choose') ? await formProblems(current) : [];
  return { output: `${notes.join('\n')}\n\n${view.output}${problems.length ? `\n\nOn the form: ${problems.join('; ')}.` : ''}` };
}

/** What a Google sign-in page needs decided, said where the agent is already looking. The account is the
 * profile's `sso_email` (the one every site was signed up with, so a returning site finds its account); a
 * consent screen asking for more than a sign-in needs is flagged, because "Continue" there hands a site
 * the user's calendar, mail or files. */
export async function withSignInHints(result: ToolRunResult, page: Page, stateDir: string): Promise<ToolRunResult> {
  let url: URL;
  try { url = new URL(page.url()); } catch { return result; }
  if (url.hostname !== 'accounts.google.com') return result;
  const hints: string[] = [];
  if (/accountchooser/.test(url.pathname)) {
    const email = (await listProfiles(stateDir)).map(profile => profile.fields.sso_email).find(Boolean);
    hints.push(email ? `Sign-in account: pick ${email} (the profile's sso_email): click target "${email}".` : 'Several accounts are listed and the profile has no sso_email: pick the one the task is for, and save it with profile fields {sso_email} so the next sign-in needs no choice.');
  } else if (/consent/.test(url.pathname)) {
    const text = await page.evaluate(() => (globalThis as unknown as { document: { body: { innerText: string } } }).document.body.innerText).catch(() => '');
    const broad = /(?:see, edit, share|read, compose|permanently delete|all (?:the )?(?:calendars|emails|files|contacts)|your (?:calendar|mail|drive|contacts))/i.exec(text)?.[0];
    if (broad) hints.push(`This consent screen asks for more than a sign-in ("${broad}"). Decline it with Cancel unless the task is to give that access.`);
  }
  return hints.length ? { ...result, output: `${result.output}\n\n${hints.join('\n')}` } : result;
}

/** The newest message matching from/subject in the signed-in Gmail, opened; its body. Waits for one that has just been sent. */
async function openLatestEmail(page: Page, args: WebArgs): Promise<Locator> {
  if (!args.from && !args.subject) throw new Error(`${args.action} needs from or subject.`);
  const query = [args.from ? `from:(${args.from})` : '', args.subject ? `subject:(${args.subject})` : '', 'newer_than:1d'].filter(Boolean).join(' ');
  await page.goto(`https://mail.google.com/mail/u/${args.account ?? 0}/#search/${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const row = page.locator('tr.zA').first();
  // A message just sent may not be indexed yet: look again a few times before saying it is not there.
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await row.waitFor({ timeout: 10_000 }).then(() => true, () => false)) break;
    if (attempt === 3) throw new Error(`No email matched ${query}. If Gmail asked to sign in, sign in first with login; use account to pick another Gmail /u/N.`);
    await page.reload({ waitUntil: 'domcontentloaded' });
  }
  await row.click();
  const body = page.locator('.a3s:visible').last();
  await body.waitFor({ timeout: 15_000 });
  await page.locator('.ajR').last().click({ timeout: 1_500 }).catch(() => undefined); // "show trimmed content"
  return body;
}

/** The one-time code in an email: a 4-8 character code that the text calls a code, else a lone 6-digit number. */
export function verificationCode(text: string): string | undefined {
  const flat = text.replace(/\s+/g, ' ');
  const named = /\b(?:verification|security|confirmation|login|sign[- ]?in|one[- ]time|access)?\s*code\b[^A-Za-z0-9]{0,20}([A-Z0-9]{4,8})\b/i.exec(flat)
    ?? /\b([A-Z0-9]{4,8})\b[^.]{0,30}\bis your (?:\w+ )?code\b/i.exec(flat);
  if (named && /\d/.test(named[1]!)) return named[1];
  const sixes = [...new Set(flat.match(/(?<![\w.-])\d{6}(?![\w-])/g) ?? [])];
  return sixes.length === 1 ? sixes[0] : undefined;
}

async function act(page: Page, args: WebArgs, ctx: ToolContext): Promise<ToolRunResult> {
  if (INTERACTIONS.has(args.action)) {
    const one: Step = { do: args.action as Step['do'], ...(args.target ? { target: args.target } : {}), ...(args.text !== undefined ? { text: args.text } : {}), ...(args.key ? { key: args.key } : {}), ...(args.direction ? { direction: args.direction } : {}), ...(args.accept_dialog ? { accept_dialog: true } : {}), ...(args.gone ? { gone: true } : {}), ...(args.seconds ? { seconds: args.seconds } : {}) };
    return runSteps(page, [one], ctx, args.tab);
  }
  switch (args.action) {
    case 'open': {
      await page.goto(webAddress(args.url), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await settle(page);
      const seen = await observeComputerPage(page, ctx.acceptsImages === true);
      const notes = await readSiteNotes(ctx.stateDir, new URL(page.url()).hostname).catch(() => '');
      return notes ? { ...seen, output: `Notes from earlier on this site:\n${notes}\n\n${seen.output}` } : seen;
    }
    case 'notes': {
      const host = args.host?.trim() || new URL(page.url()).hostname;
      if (!args.note) return { output: (await readSiteNotes(ctx.stateDir, host)) || `No notes for ${host} yet.` };
      return { output: `Saved. Notes for ${host}:\n${await addSiteNote(ctx.stateDir, host, args.note)}` };
    }
    case 'observe': return observeComputerPage(page, ctx.acceptsImages === true, args.full === true, args.find);
    case 'steps':
      const list = typeof args.steps === 'string' ? (() => { try { return JSON.parse(args.steps) as Step[]; } catch { return undefined; } })() : args.steps;
      if (!Array.isArray(list) || !list.length) throw new Error('steps needs a list, e.g. [{"do":"click","target":"e5"}].');
      return runSteps(page, list, ctx, args.tab);
    case 'open_email_link': {
      const body = await openLatestEmail(page, args);
      const links = await body.locator('a[href]').evaluateAll(nodes => nodes.map(node => ({ href: (node as unknown as { href: string }).href, text: (node as unknown as { textContent: string | null }).textContent ?? '' })));
      const real = links.map(link => { try { const u = new URL(link.href); return { ...link, href: u.hostname.endsWith('google.com') && u.pathname === '/url' ? u.searchParams.get('q') ?? link.href : link.href }; } catch { return link; } })
        .filter(link => /^https:/.test(link.href) && !/unsubscribe|accounts\.google\.com|mail\.google\.com|privacy|terms/i.test(link.href));
      const wanted = args.link?.toLowerCase();
      const pick = wanted ? real.find(link => `${link.href} ${link.text}`.toLowerCase().includes(wanted)) : real[0];
      if (!pick) throw new Error(`The email has no ${wanted ? `link mentioning "${args.link}"` : 'usable link'}. Links found: ${real.slice(0, 5).map(link => displayUrl(link.href)).join(', ') || 'none'}.`);
      await page.goto(pick.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await settle(page);
      return observeComputerPage(page, ctx.acceptsImages === true);
    }
    case 'read_email_code': {
      // A one-time sign-up or sign-in code is short-lived and meant to be typed, so it is returned as text
      // (an API key never is). The page the code is for is left as it was: Gmail is read in a tab of its own.
      const mail = await page.context().newPage();
      try {
        const text = await (await openLatestEmail(mail, args)).innerText();
        const code = verificationCode(text);
        if (!code) throw new Error(`The email from ${args.from ?? args.subject} has no code in it. It says: "${text.replace(/\s+/g, ' ').slice(0, 160)}".`);
        return { output: `Code: ${code}. Type it into the page that asked for it; it is already waiting in the tab you left.` };
      } finally { await mail.close().catch(() => undefined); }
    }
    case 'login': {
      const outcome = await loginComputerPage({ stateDir: ctx.stateDir, page, signal: ctx.signal, newAccount: args.new_account === true,
        ask: async (site, fields, signal) => {
          if (!ctx.requestPrivateLogin) throw new LoginError('This chat cannot show private login fields.');
          return ctx.requestPrivateLogin(site, fields, signal);
        }, onVerification: () => ctx.emitOutput?.('Approve the sign-in or finish verification in the open browser.\n') });
      const failed = outcome === 'unverified' || outcome === 'saved_login_rejected';
      // Signed in: the page you landed on comes with it, so there is nothing more to ask for.
      const landed = failed ? undefined : await (async () => {
        try { return await observeComputerPage(page.isClosed() ? await computerPage(ctx.stateDir, args.tab) : page, false); }
        catch { return undefined; } // the sign-in worked whether or not the page can be read
      })();
      return { output: `${loginOutcomeMessage(outcome)}${landed ? `\n\n${landed.output}` : ''}`, ...(failed ? { isError: true } : {}) };
    }
    case 'capture_secret': {
      // Before anything is clicked: a key must not be created for a plan that cannot deliver it.
      const plan = normalizeSendTo(args.send_to);
      const planProblem = plan?.length ? await destinationProblem(ctx.stateDir, plan) : undefined;
      if (planProblem) throw new Error(`${planProblem} Nothing was clicked.`);
      const name = args.secret_name?.trim() || `${new URL(page.url()).hostname.replace(/^www\./, '')}/key`;
      // The clipboard is one thing and a Copy button only works in the focused tab: captures take turns, each in front.
      const { length, shape, via, check, sent } = await inOrder('clipboard', async () => { await page.bringToFront().catch(() => undefined); return captureSecret({ ...(args.paste ? { paste: true } : {}), stateDir: ctx.stateDir, page, name, signal: ctx.signal,
        ...(plan?.length ? { sendTo: plan } : {}),
        ...(args.target ? { trigger: async () => { await clickOrHint(await locate(page, args.target)); } } : {}),
        ...(args.target ? { readTarget: async () => { const element = await locate(page, args.target); return (await element.inputValue({ timeout: 1_000 }).catch(() => '')) || (await element.innerText({ timeout: 1_000 }).catch(() => '')); } } : {}),
        ask: async (secretName, hint, signal) => {
          if (!ctx.requestPrivateSecret) throw new LoginError('Not saved: this chat cannot show a private prompt, and the key could not be found on its own.');
          return ctx.requestPrivateSecret(secretName, hint, signal);
        } }); });
      const refused = check.verdict === 'rejected';
      const lines = [
        `SAVED "${name}" in ClikCode Secrets Manager (${length} characters, ${shape}, taken from ${via}). You were not shown the key; if that does not match what you expected (an id where a secret should be), delete it and capture again.`,
        refused ? `NOT VERIFIED: ${check.detail}. It was kept because the site shows a new key only once, and it was NOT sent anywhere. Wait a minute, then send it with send_secret and check the result.`
          : check.verdict === 'works' ? `Checked: ${check.detail}.` : `Not checked: ${check.detail}.`,
        ...sent.map(delivery => `${delivery.ok ? 'SENT' : 'NOT SENT'} - ${delivery.label}: ${delivery.message}`),
        ...(refused ? [] : sent.some(delivery => !delivery.ok) ? ['The key is still saved. Fix the cause, then send it again with send_secret.'] : sent.length ? [] : ['Nothing was sent anywhere: use send_to to send it on, or send_secret later.']),
      ];
      return { output: lines.join('\n'), ...(sent.some(delivery => !delivery.ok) ? { isError: true } : {}) };
    }
    case 'handoff': {
      // The link is returned at once; the handoff runs on, and a second handoff call waits for the user to finish.
      let running = handoffs.get(ctx.stateDir);
      if (!running) {
        const stop = new AbortController();
        let resolveLink!: (link: string) => void; let failLink!: (error: Error) => void;
        const link = new Promise<string>((resolve, reject) => { resolveLink = resolve; failLink = reject; });
        link.catch(() => undefined);
        // The phone reaches this computer directly over the user's Tailscale network: no relay, no third party.
        const host = tailnetAddress();
        if (!host) throw new Error('A handoff needs this computer and your phone on the same Tailscale network, and this computer is not on one (no Tailscale address). Install Tailscale and sign in on both, or finish this step at the computer.');
        const done = runTailnetHandoff({ stateDir: ctx.stateDir, host, signal: stop.signal, onLink: resolveLink })
          .then(() => ({ ok: true as const }), (error: unknown) => { failLink(error instanceof Error ? error : new Error(String(error))); return { ok: false as const, message: error instanceof Error ? error.message : String(error) }; })
          .finally(() => { handoffs.delete(ctx.stateDir); });
        running = { link, done, stop };
        handoffs.set(ctx.stateDir, running);
        const url = await Promise.race([running.link, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('The phone link did not come up.')), 45_000))]);
        return { output: `Phone link over Tailscale (the phone must be on the same tailnet; valid 10 minutes, one use): ${url}\nTell the user to open it and finish the browser step (CAPTCHA, MFA). Then call handoff again to wait until they are done.` };
      }
      const outcome = await Promise.race([running.done, new Promise<'waiting'>(resolve => setTimeout(() => resolve('waiting'), 90_000))]);
      if (outcome === 'waiting') return { output: 'The user has not finished yet. Call handoff again to keep waiting.' };
      return outcome.ok ? { output: 'The user finished the browser step. Continue from the current page.' } : { output: outcome.message, isError: true };
    }
    default: throw new Error(`Unknown action "${String(args.action)}". Actions: ${ACTION_LIST}.`);
  }
}

/** A native dialog or separate popup window is outside the page, so a click
 * that never lands is most often that: point the agent at the desktop tool. */
async function clickOrHint(target: Locator): Promise<void> {
  try { await press(target); }
  catch (error) {
    if (!(error instanceof Error) || !/timeout/i.test(error.message)) throw error;
    throw new Error(`${error.message.split('\n')[0]} If a popup window or browser dialog is in front of the page, use computer_desktop to see and answer it.`);
  }
}
