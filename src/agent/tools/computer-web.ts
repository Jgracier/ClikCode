/** Page-level browser actions in ClikCode's own Chrome profile. */
import { quiet } from '../../runtime/lifecycle-log.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defineTool } from '../tool-contract.js';
import { adoptPage, closeComputerPage, computerPage, openComputerPage, openNewComputerPage } from '../computer/browser.js';
import { checkKey, clickExtras, clickWith, closeTab, dragStep, fillTarget, hoverStep, PAGE_ACTIONS, PAGE_DESCRIPTION, PAGE_PARAMETERS, pageAction, scrollStep, waitForState, withScreenshot, type PageAction, type PageArgs, type ScrollDirection, type StepExtras } from '../computer/page-control.js';
import { COMPUTER_OFF, computerEnabled, generatedPasswordsAllowed, unattendedEnabled } from '../computer/settings.js';
import { MAX_TOOL_IMAGE_BYTES, sniffImage } from '../images.js';
import { keyFieldValues, maskSensitive, sensitiveValues } from '../computer/sensitive-fields.js';
import { storeSecretTool } from './store-secret.js';
import { sharedState } from '../computer/shared-state.js';
import { forgetSavedLogins, savedLoginFields, savedLoginsForSite, saveLoginFields } from '../computer/credential-vault.js';
import { loginValueFor } from '../computer/login-fill.js';
import { describeRecipe, fillPlaceholders, getRecipe, listRecipes, replayRecipe, saveRecipe } from '../computer/signup-recipes.js';
import { addSiteNote, readSiteNotes } from '../computer/site-notes.js';
import { assertCustomKey, bestProfileFor, customFieldFor, defaultProfile, describeProfile, listProfiles, PASSWORD_SECRET, PROFILE_KEYS, phoneFor, birthdayFor, profileKeyFor, readProfileSecret, saveProfile, saveProfileSecret, secretFieldFor, type FieldHint, type ProfileKey } from '../computer/profiles.js';
import { expectSignup, holdSignup, pendingSignupPassword, pendingSignupUsername, savedPasswordFor, settleSignup, sitePasswordFor } from '../computer/signup-login.js';
import { generatePassword } from '../computer/password-policy.js';
import { generatedFor, readPasswordPolicy, rememberGenerated, retryRejectedPassword } from '../computer/password-retry.js';
import { loginComputerPage, loginOutcomeMessage } from '../computer/login-page.js';
import { LoginError } from '../computer/login-error.js';
import { type LoginField } from '../computer/login-fields.js';
import { registerSecret, scrubSecrets, showsSecret } from '../computer/secret-scrubber.js';
import { profileLoginAnswers } from '../computer/profile-login.js';
import { Parked, park } from '../computer/parking.js';
import { hideKeyLikeText } from '../computer/secret-finder.js';
import { answerDialog, bindDialogs, dialogNote, hasPendingDialog, pendingDialogNote, settleWaitingDialog, withDialogNotices, withDialogs } from '../computer/page-dialogs.js';
import { FILES_ENV_ACTIONS, FILES_ENV_HELP, FILES_ENV_PARAMETERS, type FilesEnvAction, type FilesEnvArgs } from '../computer/files-env-schema.js';
import { approvedUploadPath, isUploadPath } from '../computer/upload-files.js';
import { bindDownloads, describeDownloads, downloadNotes } from '../computer/downloads.js';
import { SEND_TO_HELP, SEND_TO_SCHEMA } from './store-secret.js';
import { destinationProblem, normalizeSendTo, type Destination } from '../computer/secret-destinations.js';
import { captureSecret } from '../computer/secret-capture.js';
import { emailConnected, waitForEmail } from '../computer/email-api.js';
import { codeFromMailbox, looksLikeCodeEmail, looksLikeLinkEmail, verificationCode } from '../computer/email-code.js';
import { connectEmail } from '../computer/email-consent.js';
import { beginJournal, noteStep, recordVerified } from '../computer/recipe-recorder.js';
import { lintRecipe } from '../computer/recipe-tools.js';
import { oauthConnect } from '../computer/oauth-consent.js';
import { runTailnetHandoff, tailnetAddress } from '../computer/tailnet-handoff.js';
import type { Frame, Locator, Page } from 'playwright-core';
import type { ToolContext, ToolRunResult } from '../tool-contract.js';

type Step = { do: 'click' | 'fill' | 'choose' | 'press' | 'scroll' | 'wait' | 'upload' | 'hover' | 'drag'; target?: string; at?: 'start' | 'end'; text?: string; key?: string; direction?: ScrollDirection; accept_dialog?: boolean; gone?: boolean; seconds?: number } & StepExtras;
type WebArgs = {
  action: 'open' | 'close' | 'observe' | 'click' | 'fill' | 'choose' | 'press' | 'scroll' | 'wait' | 'upload' | 'steps' | 'login' | 'handoff' | 'capture_secret' | 'send_secret' | 'profile' | 'open_email_link' | 'read_email_code' | 'email_connect' | 'oauth_connect' | 'notes' | 'recipe' | 'queue' | 'network' | 'preflight' | 'forget_login' | 'help' | 'hover' | 'drag' | PageAction | FilesEnvAction;
  tab?: string; at?: 'start' | 'end'; url?: string; host?: string; note?: string; recipe_op?: 'save' | 'get' | 'run' | 'list'; login_route?: string; key_page?: string; capture_hint?: string; target?: string; text?: string; key?: string; direction?: ScrollDirection; steps?: Step[] | string; full?: boolean; find?: string; gone?: boolean; seconds?: number; accept_dialog?: boolean;
  new_account?: boolean; secret?: string; to?: string; with?: Record<string, string> | string; ask?: boolean; from?: string; subject?: string; link?: string; account?: number; fields?: Record<string, string>; ask_fields?: Array<{ key: string; label: string; match?: string[]; optional?: boolean; format?: string; options?: string[]; secret?: boolean }>; custom?: Record<string, { label?: string; value: string; match?: string[] }>; label?: string; secret_name?: string; vendor?: string; owner?: string; env?: string; task?: { vendor: string; kind?: string; status?: string; reason?: string; note?: string; owner?: string; connectors?: string[] }; bodies?: boolean; tasks?: boolean; task_status?: string; task_reason?: string; paste?: boolean; send_to?: Destination[] | Destination | string;
} & PageArgs & FilesEnvArgs;

export function webAddress(value: string | undefined): string {
  if (!value) throw new Error('Open needs a website URL.');
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Open needs an HTTP or HTTPS website URL without credentials.');
  return parsed.href;
}

const REF = /^(?:f\d+)?e\d+$/;
const isStandardKey = (key: string): boolean => (PROFILE_KEYS as readonly string[]).includes(key);

/** What `target` points at: a [ref=eN] from the last view (any element, named or not, in any frame),
 * or visible text for the controls of a sign-in page, which are listed by name without references. */
export async function locate(page: Page, target: string | undefined): Promise<Locator> {
  const wanted = target?.trim();
  if (!wanted) throw new Error('Say what to act on: a [ref=…] from the page view, or its visible text.');
  if (REF.test(wanted)) {
    const byRef = page.locator(`aria-ref=${wanted}`);
    if (await byRef.count()) return byRef;
    throw new Error(`Nothing on the page has the reference ${wanted}: the page has changed since it was read.`);
  }
  // The page first, then each frame in it (a sign-up form or sign-in button inside an iframe, same-origin or not).
  const scopes: Array<Page | Frame> = [page, ...page.frames().filter(frame => frame !== page.mainFrame() && frame.url() && frame.url() !== 'about:blank')];
  for (const scope of scopes) {
    // A field's label names the field, so the field is found before the label's text.
    // An option or menu item of an open list beats the same words shown in the closed control that opened it.
    for (const candidate of [scope.getByLabel(wanted, { exact: true }), scope.getByPlaceholder(wanted, { exact: true }), scope.getByRole('option', { name: wanted, exact: true }), scope.getByRole('menuitem', { name: wanted, exact: true }), scope.getByText(wanted, { exact: true }), scope.getByTitle(wanted, { exact: true })]) {
      const visible = candidate.locator('visible=true');
      if (await visible.count().catch(() => 0)) return visible.first();
    }
  }
  // A field's label can include its options ("Plan Free Pro"): a near match on the label is still that field.
  for (const scope of scopes) {
    for (const candidate of [scope.getByLabel(wanted), scope.getByPlaceholder(wanted)]) {
      const visible = candidate.locator('visible=true');
      if (await visible.count().catch(() => 0) === 1) return visible.first();
    }
  }
  throw new Error(`Nothing on the page shows "${wanted}".`);
}

/** The readable name of the control a [ref=…] points at (what a saved recipe names it by), or undefined. */
async function controlName(page: Page, target: string | undefined): Promise<string | undefined> {
  const wanted = target?.trim();
  if (!wanted || !REF.test(wanted)) return undefined;
  const element = page.locator(`aria-ref=${wanted}`);
  return element.first().evaluate(node => {
    const el = node as unknown as { labels?: ArrayLike<{ textContent: string | null }>; getAttribute(name: string): string | null; innerText?: string; value?: string; tagName: string };
    const clean = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim();
    const input = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
    return clean(el.getAttribute('aria-label')) || clean(el.labels?.[0]?.textContent) || clean(el.getAttribute('placeholder')) || (input ? '' : clean(el.innerText)) || clean(el.getAttribute('title')) || (el.tagName === 'INPUT' && /^(submit|button)$/.test(el.getAttribute('type') ?? '') ? clean(el.value) : '');
  }, undefined, { timeout: 2_000 }).then(name => name || undefined, () => undefined);
}

const journalKey = (stateDir: string, tab?: string): string => tab ? `${stateDir}#${tab}` : stateDir;

/** Radios, checkboxes and switches are often visually hidden behind a styled label, and a
 * click can land on something in front: fall back to clicking the element itself. */
async function press(target: Locator, at?: 'start' | 'end'): Promise<void> {
  // Where the middle of a label is a link ("I agree to the Terms"), the edge is the box: click there.
  if (at) {
    const box = await target.boundingBox({ timeout: 6_000 });
    if (box) { await target.click({ position: { x: at === 'start' ? Math.min(6, box.width / 2) : Math.max(box.width - 6, box.width / 2), y: box.height / 2 }, timeout: 6_000 }); return; }
  }
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
export { verificationCode };
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
  if (hidden || (await sensitiveValues(page)).length || (await keyFieldValues(page)).length || showsSecret(snapshot) || showsSecret(await page.evaluate(visibleText).catch(() => ''))) return { output: `${output}\n\n[Screenshot withheld: the page holds a typed credential or a saved secret.]` };
  let bytes = await page.screenshot({ type: 'jpeg', quality: 65, animations: 'disabled', timeout: 10_000 });
  if (bytes.length > MAX_TOOL_IMAGE_BYTES) bytes = await page.screenshot({ type: 'jpeg', quality: 35, animations: 'disabled', timeout: 10_000 });
  const found = sniffImage(bytes);
  if (!found || bytes.length > MAX_TOOL_IMAGE_BYTES) return { output: `${output}\n\n[Screenshot too large to show.]` };
  return { output, images: [{ mimeType: found.mimeType, data: bytes.toString('base64') }] };
}

/** Wait for what an action started to land, so the view that follows is a finished page, not a spinner. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(quiet('agent/tools/computer-web'));
  // Quiet, not "network idle" (many sites never go idle): done once the page has stopped changing for a moment.
  await page.evaluate(() => new Promise<void>(resolve => {
    const g = globalThis as unknown as { document: object; MutationObserver: new (callback: () => void) => { observe(target: object, options: object): void; disconnect(): void }; setTimeout(callback: () => void, ms: number): number; clearTimeout(id: number): void };
    let quiet = g.setTimeout(done, 250);
    const watcher = new g.MutationObserver(() => { g.clearTimeout(quiet); quiet = g.setTimeout(done, 250); });
    watcher.observe(g.document, { subtree: true, childList: true, attributes: true, characterData: true });
    g.setTimeout(done, 1_500);
    function done(): void { watcher.disconnect(); resolve(); }
  })).catch(quiet('agent/tools/computer-web')); // a navigation destroys the page being watched: the next look is a new page
}

const ACTION_LIST = ['open · close · observe · click · fill · choose · press · scroll · wait · upload · steps · login · handoff · capture_secret · send_secret · profile · open_email_link · read_email_code · email_connect · oauth_connect · notes · recipe · queue · network · preflight · forget_login · help · hover · drag · back · forward · reload · tabs · switch · evaluate · screenshot · console', ...FILES_ENV_ACTIONS].join(' · ');

const WEB_PARAMETERS = { type: 'object', additionalProperties: true, required: ['action'], properties: {
    action: { type: 'string', description: ACTION_LIST },
    tab: { type: 'string', description: 'Name of your own tab. Agents working in parallel each pass a different name on every call, so they never share, read or navigate each other\'s page. Leave out when you are the only one using the browser.' },
    at: { type: 'string', enum: ['start', 'end'], description: 'click: click the left (start) or right (end) edge of the element instead of its middle, for a checkbox whose label has a link in the middle.' },
    url: { type: 'string', description: 'open: the website address. wait with until url: text the address must contain (or /regex/).' },
    host: { type: 'string', description: 'notes: the site (default: the open page\'s).' },
    note: { type: 'string', description: 'notes: a step, address or gotcha worth knowing the next time this task is done on the site. Leave out to read the saved notes. Never a key or password.' },
    recipe_op: { type: 'string', enum: ['save', 'get', 'run', 'list'], description: 'recipe: save (after a signup or key capture worked: host, login_route, steps, key_page, capture_hint), get, run (replay the saved steps; stops at the first failure or at a captcha, SMS/MFA code, payment or review page, and shows the page so you can take over), list.' },
    login_route: { type: 'string', enum: ['google', 'github', 'email'], description: 'recipe: how the account was signed in (save), or which recipe to get or run.' },
    key_page: { type: 'string', description: 'recipe save: the address of the page where the key is created or shown.' },
    capture_hint: { type: 'string', description: 'recipe save: how the key was captured (which button reveals or copies it). Never the key itself.' },
    target: { type: 'string', description: 'oauth_connect: the ClikDeploy connector id (slack, github). click, fill, capture_secret: a [ref=…] from the page view (e5, or f1e2 inside a frame), or the visible text of a sign-in page control. forget_login: the site (a host such as wordnik.com, or a URL).' },
    text: { type: 'string', description: 'fill: the text. Leave it out for what only the user knows (name, address, phone, a password): the user is asked privately, once for all such fields in the call, and you are not shown the answer. wait: the words to wait for.' },
    gone: { type: 'boolean', description: 'wait: wait for the text to disappear instead of appear.' },
    seconds: { type: 'number', description: 'wait: how long to wait at most (default 30, up to 120). read_email_code, open_email_link: how long to wait for the email to arrive when a mailbox is connected (default 90).' },
    find: { type: 'string', description: 'observe: show only the lines that mention these words.' },
    key: { type: 'string', description: 'press: one key or combination: Enter, Escape, Tab, ArrowDown, a single character (/ . a or a space), or modifiers joined with + (Control+a, Meta+k, Shift+Tab).' },
    direction: { type: 'string', enum: ['up', 'down', 'left', 'right', 'top', 'bottom'], description: 'scroll: which way (default down); top and bottom go to the edge. With a target, scrolls inside that element; a target alone is scrolled into view.' },
    ...PAGE_PARAMETERS,
    steps: { type: ['array', 'string'], description: 'steps: what to do, in order, e.g. [{do:"fill", target:"e4", text:"My key"}, {do:"click", target:"e9"}].',
      items: { type: 'object', additionalProperties: false, required: ['do'], properties: {
        do: { type: 'string', enum: ['click', 'fill', 'choose', 'press', 'scroll', 'wait', 'upload', 'hover', 'drag'] }, target: { type: 'string' }, text: { type: 'string' }, key: { type: 'string' }, direction: { type: 'string', enum: ['up', 'down', 'left', 'right', 'top', 'bottom'] },
        button: { type: 'string', enum: ['left', 'right', 'middle'] }, count: { type: 'integer' }, modifiers: { type: ['array', 'string'], items: { type: 'string' } }, x: { type: 'number' }, y: { type: 'number' }, to_x: { type: 'number' }, to_y: { type: 'number' }, to_target: { type: 'string' }, amount: { type: 'number' }, until: { type: 'string', enum: ['text', 'network_idle', 'visible', 'hidden', 'enabled', 'disabled', 'url'] }, selector: { type: 'string' }, url: { type: 'string' }, accept_dialog: { type: 'boolean' }, at: { type: 'string', enum: ['start', 'end'], description: 'click: click the left (start) or right (end) edge of the element instead of its middle, for a checkbox whose label has a link in the middle.' }, gone: { type: 'boolean' }, seconds: { type: 'number' },
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
    label: { type: 'string', description: 'forget_login: only the saved login with this username or email (default: every saved login for the site). profile: which profile (default: the one called Personal, else the one with the most standard fields, else a new one called Personal).' },
    ask_fields: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { key: { type: 'string' }, label: { type: 'string' }, match: { type: 'array', items: { type: 'string' } }, optional: { type: 'boolean' }, format: { type: 'string', description: 'Types itself as the user enters it: date (##/##/####), phone ((###) ###-####), zip, time, or a pattern where # is a digit, A a letter, * either and anything else a literal the box inserts and jumps over.' }, options: { type: 'array', items: { type: 'string' }, description: 'A fixed set of answers shown as a selector (arrow keys in the terminal, radios in VS Code) instead of a text box.' }, secret: { type: 'boolean', description: 'The answer is a secret (a password to use for sign-ups, key "password"; a recovery code): typed hidden, kept in Secrets Manager with the profile, and never shown to you. A later fill of a password box with no text uses it.' } }, required: ['key', 'label'] }, description: 'profile: ask the user, privately and in one prompt, for details a task needs beyond the standard ones, and keep them in a profile (with label, a new one) so every later fill with no text uses them. key is lower_snake_case (app_name, privacy_policy_url); label is what the user is asked; match lists the words a form may label it with (["app name","application name"]); optional fields may be left empty. Details only; a password or code goes in with secret: true.' },
    custom: { type: 'object', additionalProperties: { type: 'object', additionalProperties: false, properties: { label: { type: 'string' }, value: { type: 'string' }, match: { type: 'array', items: { type: 'string' } } }, required: ['value'] }, description: 'profile: save custom details you already know (a redirect address, the app name you chose) into a profile, same shape as ask_fields answers: {key: {label, value, match}}.' },
    vendor: { type: 'string', description: 'capture_secret: the vendor the key is for, recorded with it.' },
    owner: { type: 'string', description: 'capture_secret: the account the key or app belongs to (default: the profile\'s sign-in email).' },
    env: { type: 'string', description: 'capture_secret: production, sandbox or test.' },
    task: { type: 'object', additionalProperties: false, properties: { vendor: { type: 'string' }, kind: { type: 'string', enum: ['oauth-app', 'api-key', 'test-account', 'webhook', 'other'] }, status: { type: 'string', enum: ['queued', 'working', 'done', 'needs-human', 'blocked', 'no-self-serve'] }, reason: { type: 'string', enum: ['captcha', 'sms', 'email', 'payment', 'identity', 'review', 'two-factor', 'no-logo', 'unsupported-protocol', 'other'] }, note: { type: 'string' }, owner: { type: 'string' }, connectors: { type: 'array', items: { type: 'string' } } }, required: ['vendor'], description: 'queue: record or update one vendor task (one per vendor and kind). Set status needs-human with a reason when a person must act (captcha, sms, payment), done when finished, blocked when it cannot be done. Always record the outcome here instead of only saying it.' },
    bodies: { type: 'boolean', description: 'network: also show request and answer bodies (truncated, key-like values hidden). Default: shapes only.' },
    tasks: { type: 'boolean', description: 'queue: list the tasks (filter with task_status, task_reason) with a summary.' },
    task_status: { type: 'string' }, task_reason: { type: 'string' },
    secret_name: { type: 'string', description: 'capture_secret: name to save the key under (default: the site\'s name plus "/key").' },
    send_to: { ...SEND_TO_SCHEMA, description: 'capture_secret: ' + SEND_TO_HELP },
    ...FILES_ENV_PARAMETERS,
  } };

const WEB_DESCRIPTION = [
    "Drive ClikCode's own Chrome (its own saved profile; it starts by itself). open and observe return the page, with a [ref=…] on each element: pass a ref as target (or visible text) to click or fill. After an action you get only what changed (and any open dialog); observe shows the whole page again. A new tab or popup the page opens is followed automatically.",
    'Actions: open (a URL) · observe (the page again; full: true adds header and footer; find: "words" shows only the lines that mention them, for a long page) · click · fill · choose (an option of a dropdown: target + text) · press · scroll · wait (for text to appear or go, up to 2 minutes; for jobs that finish on their own) · steps (several of those in order, one call, stops at the first failure) · login · handoff · capture_secret · profile · open_email_link (find the newest email from a sender in the signed-in Gmail and open a link in it, one call: verification and sign-in emails) · upload (a file input or its button + text: the name of a profile file detail ending _file such as logo_file, or the absolute path of a file in the workspace or the chat\'s downloads folder; nothing else can be sent) · notes (read or add what was learned on a site: the URL that worked, the order of screens, what was missing; shown again whenever a page on that host is opened, so write one when a task finally works) · recipe (save the steps of a signup or key capture that worked, by control text, never secrets; run replays them and stops for the user at a captcha, code, payment or review page; list) · email_connect (one consent in this browser connects the signed-in Gmail; after that read_email_code and open_email_link read mail through the Gmail API, wait for it to arrive, and return only the code or the link) · oauth_connect (target = a ClikDeploy connector id: starts its OAuth connect, presses through the vendor consent screens in this signed-in browser (account named by the profile sso_email, Advanced / Go to ... (unsafe), Continue / Allow / Authorize), stops with a plain reason at a login password, MFA code, captcha or an unknown screen (sign in first with login), and confirms ClikDeploy shows an active connection) · read_email_code (the one-time code in the newest email from a sender, read in a tab of its own, so a sign-up that wants an emailed code does not need the user) · forget_login (remove the saved login for a site from the vault: target = the site, label = one account; returns only a count; use it for a login the site keeps refusing) · close.',
    PAGE_DESCRIPTION,
    'Each chat has its own tab. The user\'s autofill profile (name, email, phone, address, and any custom details you asked for with profile ask_fields) fills forms for you: fill a field with no text and it is filled from the profile, or the user is asked once and the answer is kept. If a site wants another format, fill that field with the exact text, and save the corrected value with action profile and fields. When a site offers Continue/Sign in with Google and the browser is already signed in to Google, prefer it: no new password or email check. If it offers GitHub and not Google, use Continue with GitHub (sign in to GitHub with the saved login; there is no Google sign-in inside GitHub). Only when neither is offered, fill the form with no text: the profile email fills it, and on a sign-up every password box gets a strong password made up for that site (fitted to what the page asks, retried if the site refuses it, saved with the login, never shown to you); a later sign-in fills the saved login. Every page can be read, including sign-in and signup forms; the values of password, code and card fields are masked. For anything only the user knows (a password, a code, an address, a phone number), fill the field with no text: a saved login for the site or the profile fills it, else the user is asked privately, and you are not shown the answer. That is all a sign-in or signup needs: fill the fields, click Next, repeat. (login does the same in one action for a plain email-then-password sign-in.) Never ask for a password or code in chat. When a sign-in page offers different ways in (root or IAM, another account), ask the user with ask_user, click their choice, then login. handoff returns a phone link for a CAPTCHA or MFA at once; give it to the user, then call handoff again to wait until they finish.',
    'Work through the whole task you were given without checking in at each step. Ask real choices (project, account, role set) once, up front, in one question; after that ask only when genuinely blocked (a sign-in they must type, a payment).',
    FILES_ENV_HELP,
    'API keys: go to the key page, set the options, then capture_secret with target = the final Create button and a send_to plan. It presses the site\'s Copy button or reads the file it hands over, checks the key against its service, saves it to ClikCode Secrets Manager and sends it where send_to says. You never see the key. With no target it takes a key the page already shows; never click Regenerate just to see one.',
  ].join('\n');

export const computerWebTool = defineTool<WebArgs>({
  name: 'browser_use', class: 'exec',
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
      case 'hover': return `Hover ${args.target ?? ''}`.trim();
      case 'drag': return `Drag ${args.target ?? 'from the page'}`.trim();
      case 'back': return 'Go back';
      case 'forward': return 'Go forward';
      case 'reload': return 'Reload the page';
      case 'tabs': return 'List tabs';
      case 'switch': return `Switch to tab ${args.index ?? args.text ?? ''}`.trim();
      case 'evaluate': return 'Run a script on the page';
      case 'screenshot': return 'Take a screenshot';
      case 'console': return 'Read the console';
      case 'scroll': return `Scroll ${args.direction ?? 'down'}`;
      case 'wait': return `Wait for ${args.text ? `"${args.text}"` : `${args.seconds ?? 30}s`}`;
      case 'steps': return `${args.steps?.length ?? 0} steps on the page`;
      case 'login': return 'Sign in';
      case 'handoff': return 'Hand off to phone';
      case 'capture_secret': return `Capture key${args.secret_name ? ` as ${args.secret_name}` : ''}`;
      case 'close': return 'Close browser';
      case 'downloads': return 'List downloads';
      default: return `Web ${args.action}`;
    }
  },
  paths: (args) => uploadPaths(args),
  describe: async (args) => `ClikCode browser: ${args.action}${args.url ? ` ${args.url}` : ''}${args.target ? ` ${args.target}` : ''}${uploadPaths(args).length ? ` (sends ${uploadPaths(args).join(', ')})` : ''}${args.action === 'fill' ? ` (${args.text?.length ?? 0} characters)` : ''}${args.action === 'evaluate' ? ` ${JSON.stringify((args.expression ?? '').replace(/\s+/g, ' ').slice(0, 200))}` : ''}`,
  // One chat's browser calls run in the order they were made. The model can send two at once (a capture and
  // the click that closes the dialog it reads), and a one-time key does not survive that race.
  run: (args, hostCtx) => inOrder(args.tab ? `${hostCtx.stateDir}#${args.tab}` : hostCtx.stateDir, async (): Promise<ToolRunResult> => {
    // Unattended: a private prompt about a site (a password, a code, an account choice) is parked in the queue, not shown.
    // The profile prompts are the user's own and are always shown.
    const ctx: ToolContext = await unattendedEnabled(hostCtx.stateDir) && hostCtx.requestPrivateLogin
      ? { ...hostCtx, requestPrivateLogin: (site, fields, signal) => site === 'https://profile.clikcode' ? hostCtx.requestPrivateLogin!(site, fields, signal) : park(hostCtx.stateDir, site, fields) }
      : hostCtx;
    try {
      if (!(await computerEnabled(ctx.stateDir))) throw new Error(COMPUTER_OFF);
      if (args.action === 'help') return { output: `${WEB_DESCRIPTION}\n\nArguments: ${Object.entries((WEB_PARAMETERS as { properties: Record<string, { description?: string }> }).properties).map(([name, spec]) => `${name}${spec.description ? ` (${spec.description})` : ''}`).join('; ')}` };
      if (!ACTION_LIST.split(' · ').includes(String(args.action))) throw new Error(`Unknown action "${String(args.action)}". Actions: ${ACTION_LIST}.`);
      if (args.action === 'send_secret') return storeSecretTool.run({ secret: args.secret ?? '', ...(args.to ? { to: args.to } : {}), ...(args.with ? { with: args.with } : {}), ...(args.send_to ? { send_to: args.send_to } : {}) }, ctx);
      if (args.action === 'preflight') {
        // Deterministic readiness check (browser, Google sign-in, Gmail, build, deps link); a throwaway tab, no chat tab needed.
        const { runPreflightHere } = await import('../computer/preflight.js');
        const result = await runPreflightHere(ctx.stateDir, ...(ctx.signal ? [{ signal: ctx.signal }] as const : []));
        return { output: JSON.stringify(result, null, 2), ...(result.ok ? {} : { isError: true }) };
      }
      if (args.action === 'queue') {
        const { describeTask, listTasks, saveTask, summarizeTasks } = await import('../computer/work-queue.js');
        if (args.task) return { output: `Recorded. ${describeTask(await saveTask(ctx.stateDir, args.task as Parameters<typeof saveTask>[1]))}` };
        const all = await listTasks(ctx.stateDir, { ...(args.task_status ? { status: args.task_status as never } : {}), ...(args.task_reason ? { reason: args.task_reason as never } : {}) });
        return { output: `${summarizeTasks(all)}\n${all.map(describeTask).join('\n')}` };
      }
      if (args.action === 'profile') {
        const known = args.custom && Object.keys(args.custom).length ? args.custom : undefined;
        if ((args.fields && Object.keys(args.fields).length) || known) return { output: `Saved. ${describeProfile(await saveProfile(ctx.stateDir, { ...(args.label ? { label: args.label } : {}), fields: args.fields ?? {}, ...(known ? { custom: known } : {}) }))}` };
        const all = await listProfiles(ctx.stateDir);
        // Details this task needs that no profile holds yet: one private prompt for them, kept in a profile (the
        // named one, a new one, or the first) so the next fill with no text uses them.
        if (args.ask_fields?.length) {
          if (!ctx.requestPrivateLogin) throw new Error('This chat cannot ask the user privately. Save details you know with custom, or the user can run: clikcode computer profile --custom key=value');
          for (const spec of args.ask_fields) { if (spec.secret) assertCustomKey(spec.key, true); else if (!isStandardKey(spec.key)) assertCustomKey(spec.key); if (!spec.label?.trim()) throw new Error(`ask_fields "${spec.key}" needs a label: it is what the user is asked.`); }
          const target = args.label ? all.find(profile => profile.label.toLowerCase() === args.label!.toLowerCase()) : defaultProfile(all);
          const prompt = args.ask_fields.map((spec, index): LoginField => ({ index, key: spec.key, label: spec.label.trim(), kind: spec.secret ? 'password' : spec.options?.length ? 'choice' : 'text', required: !spec.optional, ...(spec.options?.length ? { options: spec.options } : {}), ...(spec.format ? { format: spec.format } : {}), ...(isStandardKey(spec.key) ? (target?.fields[spec.key as ProfileKey] ? { current: target.fields[spec.key as ProfileKey]! } : {}) : target?.custom?.[spec.key]?.value ? { current: target.custom[spec.key]!.value } : {}) }));
          const answers = await ctx.requestPrivateLogin('https://profile.clikcode', prompt, ctx.signal);
          if (!answers) throw new Error('The user did not provide the details.');
          const answered = args.ask_fields.filter(spec => !spec.secret && (answers[spec.key] ?? '').trim());
          const secretAnswers = args.ask_fields.filter(spec => spec.secret && (answers[spec.key] ?? '').length);
          // A standard field (birthday, sso_email) goes where forms look for it; anything else is a custom detail.
          const fields = Object.fromEntries(answered.filter(spec => isStandardKey(spec.key)).map(spec => [spec.key, answers[spec.key]!]));
          const custom = Object.fromEntries(answered.filter(spec => !isStandardKey(spec.key)).map(spec => [spec.key, { label: spec.label, value: answers[spec.key]!, ...(spec.match ? { match: spec.match } : {}) }]));
          const saved = await saveProfile(ctx.stateDir, { ...(target ? { id: target.id } : { label: args.label?.trim() || 'Custom' }), fields, custom });
          for (const spec of secretAnswers) { registerSecret(answers[spec.key]!); await saveProfileSecret(ctx.stateDir, saved.id, spec.key, answers[spec.key]!, { label: spec.label, ...(spec.match ? { match: spec.match } : {}) }); }
          return { output: `Saved. ${describeProfile(secretAnswers.length ? (await listProfiles(ctx.stateDir)).find(item => item.id === saved.id) ?? saved : saved)}` };
        }
        // Asked for by the agent, or nothing saved yet: one private prompt shows what is saved ("Keep …", or type a
        // replacement) and asks for what is missing; the result is the profile.
        if (args.ask || !all.length) {
          if (!ctx.requestPrivateLogin) throw new Error('This chat cannot ask the user privately. Save a profile with fields, or the user can run: clikcode computer profile --set key=value');
          const current = (args.label ? all.find(profile => profile.label.toLowerCase() === args.label!.toLowerCase()) : defaultProfile(all))?.fields ?? {};
          const asked = PROFILE_PROMPT.map(([key, label, required], index): LoginField => ({ index, key, label, kind: 'text', required, ...(PROFILE_FORMATS[key] ? { format: PROFILE_FORMATS[key] } : {}), ...(current[key as ProfileKey] ? { current: current[key as ProfileKey]! } : {}) }));
          const answers = await ctx.requestPrivateLogin('https://profile.clikcode', asked, ctx.signal);
          if (!answers) throw new Error('The user did not provide the profile.');
          return { output: `Saved. ${describeProfile(await saveProfile(ctx.stateDir, { ...(args.label ? { label: args.label } : defaultProfile(all) ? { id: defaultProfile(all)!.id } : {}), fields: answers }))}` };
        }
        return { output: all.map(describeProfile).join('\n') };
      }
      if (args.action === 'close' && (args.index !== undefined)) { await computerPage(ctx.stateDir, args.tab); return { output: await closeTab(args, { stateDir: ctx.stateDir, ...(args.tab ? { tab: args.tab } : {}) }) }; }
      if (args.action === 'close') { await closeComputerPage(ctx.stateDir, args.tab); return { output: 'This chat\'s tab is closed.' }; }
      if (args.action === 'forget_login') {
        const site = args.target?.trim() || args.host?.trim() || args.url?.trim();
        if (!site) throw new Error('forget_login needs the site in target (a host such as wordnik.com, or a URL).');
        const count = await forgetSavedLogins(ctx.stateDir, site, args.label);
        return { output: count ? `Removed ${count} saved login${count === 1 ? '' : 's'} for ${site.replace(/^https?:\/\//, '').split('/')[0]}.` : `No saved login for ${site.replace(/^https?:\/\//, '').split('/')[0]}${args.label ? ' with that label' : ''}.` };
      }
      if (args.action === 'downloads') return { output: await describeDownloads(ctx.stateDir, ctx.sessionId) };
      if (args.action === 'open') webAddress(args.url);
      const page = args.action === 'open' && args.new_tab ? await openNewComputerPage(ctx.stateDir, args.tab) : args.action === 'open' || args.action === 'open_email_link' || args.action === 'email_connect' || args.action === 'oauth_connect' ? await openComputerPage(ctx.stateDir, args.tab) : await computerPage(ctx.stateDir, args.tab);
      bindDownloads(page, ctx.stateDir, ctx.sessionId);
      // A box the page raised and nobody answered holds the whole page: say so before anything touches it.
      bindDialogs(page, DIALOG_AWARE.has(args.action));
      const waiting = pendingDialogNote(page);
      if (waiting && args.action !== 'dialog' && args.action !== 'open') return { output: waiting };
      const leftBehind = args.action === 'open' ? await settleWaitingDialog(page, true) : undefined;
      // Playwright cannot be interrupted mid-call, so a stop returns at once
      // and the browser carries on harmlessly in the background.
      let onAbort = (): void => undefined;
      const stopped = new Promise<never>((_resolve, reject) => { onAbort = () => reject(new Error('Stopped.')); });
      stopped.catch(quiet('agent/tools/computer-web'));
      ctx.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        if (ctx.signal?.aborted) throw new Error('Stopped.');
        const done = await Promise.race([stopped, act(page, args, ctx)]);
        // The page the batch ended on, which is not `page` when a popup took over.
        const ended = await computerPage(ctx.stateDir, args.tab).catch(() => page);
        const withPicture = !done.isError && args.with_screenshot && ctx.acceptsImages === true && args.action !== 'screenshot' && !ended.isClosed() ? await withScreenshot(done, ended) : done;
        const shown = withPicture.isError ? withPicture : await withSignInHints(withPicture, ended, ctx.stateDir);
        const noted = withDialogNotices(shown, page);
        return leftBehind ? { ...noted, output: `${leftBehind}\n\n${noted.output}` } : noted;
      } finally { ctx.signal?.removeEventListener('abort', onAbort); bindDialogs(page, true); }
    } catch (error) {
      // A sign-in's own errors may echo what was typed, so only its planned messages are shown; a capture's are always the real reason.
      if (error instanceof Parked) return { output: error.message, isError: true };
      if (args.action === 'login') return { output: error instanceof LoginError ? error.message : 'Private login did not finish. Check the browser and try again.', isError: true };
      if (args.action === 'capture_secret') {
        const why = error instanceof Error ? error.message : String(error);
        // A click that creates a key at the site cannot be undone from here: say so, or a live key is left behind unnoticed.
        const clicked = (error as { afterClick?: boolean }).afterClick ? ` The click on "${args.target ?? 'the button'}" may already have created a key at the site; if so, delete it there.` : '';
        // The site often says why (an error under the button, "purchase credits"): say it too, instead of only "not found".
        const siteSaid = (error as { afterClick?: boolean }).afterClick ? await pageProblem(await computerPage(ctx.stateDir, args.tab).catch(quiet('agent/tools/computer-web'))) : '';
        return { output: scrubSecrets(`${why.startsWith('Not saved') ? why : `Not saved: ${why}`}${siteSaid ? ` The page says: "${siteSaid}".` : ''}${clicked}`), isError: true };
      }
      return { output: error instanceof Error ? error.message : String(error), isError: true };
    }
  }),
});

/** The files an upload names by path, so the permission system can show them and apply its path rules. */
function uploadPaths(args: WebArgs): string[] {
  const steps = typeof args.steps === 'string' ? [] : Array.isArray(args.steps) ? args.steps : [];
  const named = [args.action === 'upload' ? args.text : undefined, ...steps.map(step => step?.do === 'upload' ? step.text : undefined)];
  return named.filter((text): text is string => typeof text === 'string' && path.isAbsolute(text));
}

const queues = sharedState('computer-web-queue', () => new Map<string, Promise<unknown>>());
export function inOrder<T>(key: string, job: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(job, job);
  const tail = run.catch(quiet('agent/tools/computer-web'));
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}

const handoffs = sharedState('handoffs', () => new Map<string, { link: Promise<string>; done: Promise<{ ok: true } | { ok: false; message: string }>; stop: AbortController }>());

/** Actions that look at the page or act on it as the agent asked: a box the page raises meanwhile is held for the agent's answer. The others (a sign-in, a key capture) dismiss it. */
const DIALOG_AWARE: ReadonlySet<string> = new Set(['click', 'fill', 'choose', 'press', 'scroll', 'wait', 'upload', 'steps', 'observe', 'network', 'dialog', 'hover', 'drag', 'back', 'forward', 'reload', 'evaluate', 'screenshot']);

const INTERACTIONS: ReadonlySet<string> = new Set(['click', 'fill', 'choose', 'press', 'scroll', 'wait', 'upload', 'hover', 'drag']);
/** The steps a saved recipe can replay (by control text). Anything else spoils the journal instead of being recorded wrongly. */
const PLAIN_STEPS: ReadonlySet<string> = new Set(['click', 'fill', 'choose', 'press', 'scroll', 'wait', 'upload']);

/** The profile file an upload step names (`text` is the detail's name, e.g. logo_file): saved by the user, ending _file, and present on disk. */
export async function approvedFile(ctx: ToolContext | undefined, name: string | undefined): Promise<string> {
  if (!ctx || !name || !/_file$/.test(name)) throw new Error('Upload needs text naming a profile file detail ending _file, such as logo_file (save one with profile custom), or the absolute path of a file in the workspace or the downloads folder.');
  for (const profile of await listProfiles(ctx.stateDir)) {
    const value = profile.custom?.[name]?.value;
    if (value) {
      try { if ((await fs.stat(value)).isFile()) return value; } catch { /* reported below */ }
      throw new Error(`The file saved as ${name} is not on this computer: ${path.basename(value)}.`);
    }
  }
  throw new Error(`The profile has no ${name}. The user can add it with: clikcode computer profile --custom ${name}=/path/to/file`);
}

/** What one step did. `halt` means the steps after it must not run: they were written for a page that is not there yet. */
type StepOutcome = string | { note: string; halt: true };

/** Long jobs (an API being enabled, a resource being created) finish on their own: wait for words to
 * appear (or go) instead of looking again and again. Gives up with the page as it is, and says so. */
async function waitOn(page: Page, step: Step): Promise<StepOutcome> {
  if (step.until && step.until !== 'text' || (!step.text?.trim() && (step.selector || step.url !== undefined))) {
    const done = await waitForState(page, step, { locate, displayUrl });
    return done.halt ? { note: done.note, halt: true } : done.note;
  }
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
async function doStep(page: Page, step: Step, ctx?: ToolContext): Promise<StepOutcome> {
  switch (step.do) {
    case 'upload': {
      // Only a file the user put in their profile (a custom detail whose name ends _file, such as logo_file) can be sent to a site.
      const file = isUploadPath(step.text) ? await approvedUploadPath({ cwd: ctx?.cwd ?? process.cwd(), stateDir: ctx?.stateDir ?? '', homeDir: ctx?.homeDir ?? os.homedir(), ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {}) }, step.text!) : await approvedFile(ctx, step.text);
      const target = await locate(page, step.target);
      const isFileInput = await target.evaluate(node => { const input = node as unknown as { tagName: string; type?: string }; return input.tagName === 'INPUT' && input.type === 'file'; }).catch(() => false);
      if (isFileInput) await target.setInputFiles(file, { timeout: 10_000 });
      else {
        const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 8_000 }), clickOrHint(target)]);
        await chooser.setFiles(file);
      }
      return `Uploaded ${path.basename(file)}${isUploadPath(step.text) ? '' : ` (${step.text})`} to ${step.target}.`;
    }
    case 'click': {
      const extras = clickExtras(step);
      const coordinates = !step.target?.trim() && step.x !== undefined;
      const target = coordinates ? undefined : await locate(page, step.target);
      const { dialogs } = await withDialogs(page, step.accept_dialog === true, () => extras || coordinates || (target && step.x !== undefined) ? clickWith(page, target, step) : clickOrHint(target!, step.at));
      const how = extras ? ` (${[extras.modifiers.join('+'), extras.clickCount === 2 ? 'double' : extras.clickCount === 3 ? 'triple' : '', extras.button !== 'left' ? extras.button : ''].filter(Boolean).join(' ')})` : '';
      return `Clicked ${coordinates ? `at ${step.x},${step.y}` : step.target}${how}.${dialogNote(dialogs, step.accept_dialog === true)}`;
    }
    case 'hover': {
      const target = step.target?.trim() ? await locate(page, step.target) : undefined;
      await hoverStep(page, target, step);
      return `Hovered ${target ? step.target : `at ${step.x},${step.y}`}.`;
    }
    case 'drag': {
      const from = step.target?.trim() ? await locate(page, step.target) : undefined;
      const to = step.to_target?.trim() ? await locate(page, step.to_target) : undefined;
      await dragStep(page, from, to, step);
      return `Dragged ${from ? step.target : `from ${step.x},${step.y}`} to ${to ? step.to_target : `${step.to_x},${step.to_y}`}.`;
    }
    case 'fill': {
      if (typeof step.text !== 'string') throw new Error('Fill needs text.');
      return fillTarget(page, await locate(page, step.target), step.text, step.target);
    }
    case 'choose': {
      // A dropdown that is not a <select>: open it, type to narrow the list, take the option that says this.
      if (!step.text) throw new Error('Choose needs the option text.');
      const target = await locate(page, step.target);
      if (await target.evaluate(element => (element as unknown as { tagName: string }).tagName).catch(() => '') === 'SELECT') { await target.selectOption({ label: step.text }, { timeout: 10_000 }).catch(() => target.selectOption(step.text!, { timeout: 10_000 })); return `Chose "${step.text}".`; }
      await clickOrHint(target);
      await page.keyboard.insertText(step.text).catch(quiet('agent/tools/computer-web'));
      await page.waitForTimeout(250);
      const option = page.getByRole('option', { name: step.text, exact: true }).or(page.getByRole('option', { name: new RegExp(step.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') })).first();
      if (await option.count().catch(() => 0)) await option.click({ timeout: 5_000 });
      else await page.keyboard.press('Enter');
      return `Chose "${step.text}".`;
    }
    case 'press':
      await page.keyboard.press(checkKey(step.key));
      return `Pressed ${step.key}.`;
    case 'scroll': return scrollStep(page, step.target?.trim() ? await locate(page, step.target) : undefined, step);
    case 'wait': return waitOn(page, step);
    default: throw new Error(`Unknown step "${String((step as { do?: unknown }).do)}".`);
  }
}

/** What a form field is, for matching it to a saved profile and for the private prompt. */
async function describeField(target: Locator): Promise<{ label: string; password: boolean; hint: FieldHint; placeholder: string; current: string; maxlength: number }> {
  return target.evaluate(element => {
    const el = element as unknown as { type?: string; value?: string; labels?: ArrayLike<{ textContent: string | null }>; getAttribute(name: string): string | null };
    const label = (el.labels?.[0]?.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '').trim();
    const type = el.type ?? 'text';
    return { label, password: type === 'password', placeholder: el.getAttribute('placeholder') ?? '', current: type === 'password' ? '' : el.value ?? '', maxlength: Number(el.getAttribute('maxlength')) || 0,
      hint: { autocomplete: el.getAttribute('autocomplete') ?? '', type, text: `${label} ${el.getAttribute('name') ?? ''} ${el.getAttribute('id') ?? ''}` } };
  }).catch(() => ({ label: '', password: false, hint: { autocomplete: '', type: 'text', text: '' }, placeholder: '', current: '', maxlength: 0 }));
}

/** Fields that type themselves as they are entered (06/18/1998, (719) 744-3850). */
const PROFILE_FORMATS: Readonly<Record<string, string>> = { phone: 'phone', birthday: 'date' };
const PROFILE_PROMPT: readonly [string, string, boolean][] = [['given_name', 'First name', true], ['family_name', 'Last name', true], ['email', 'Email', true], ['phone', 'Phone (with area code)', true], ['address_line1', 'Street address', true], ['address_line2', 'Apartment / suite (optional)', false], ['city', 'City', true], ['state', 'State', true], ['postal_code', 'Zip / postal code', true], ['country', 'Country', true], ['organization', 'Company (optional)', false], ['birthday', 'Date of birth (month/day/year)', false]];

const profileChoice = sharedState('profile-choice', () => new Map<string, string>());

const CODE_BOX = /one-time-code|\b(?:otp|verification|security|passcode|confirmation|pin|digit|code|character)\b/i;
/** The boxes of a code typed one character per box: 4 to 8 adjacent text boxes, each with maxlength 1, that call themselves a code. */
export function splitCodeFields<T extends { password: boolean; maxlength: number; label: string; placeholder: string; hint: { autocomplete: string; text: string } }>(fields: readonly T[]): T[] {
  const single = fields.filter(field => !field.password && field.maxlength === 1);
  if (single.length < 4 || single.length > 8) return [];
  return single.some(field => CODE_BOX.test(`${field.hint.autocomplete} ${field.label} ${field.placeholder} ${field.hint.text}`)) ? [...single] : [];
}

/** Fills that name no text: a saved profile covers what it can (name, address, phone), the user is asked
 * once, privately, for the rest, and what they answer is kept in the profile for next time. */
export async function askForFills(page: Page, steps: readonly Step[], ctx: ToolContext, label?: string): Promise<Step[]> {
  const blank = steps.filter(step => step.do === 'fill' && step.text === undefined);
  if (!blank.length) return [...steps];
  const origin = new URL(page.url()).origin;
  const fields = await Promise.all(blank.map(async step => ({ step, ...await describeField(await locate(page, step.target)) })));
  const profiles = await listProfiles(ctx.stateDir);
  let profile = profiles.length === 1 ? profiles[0] : undefined;
  if (profiles.length > 1) {
    // Never ask which profile: choose the one that fits this form best (see bestProfileFor), and keep the choice for this site.
    const remembered = profileChoice.get(`${ctx.stateDir}|${origin}`);
    profile = profiles.find(candidate => candidate.id === remembered) ?? bestProfileFor(profiles, fields.map(field => field.hint), label);
    if (profile) profileChoice.set(`${ctx.stateDir}|${origin}`, profile.id);
  }
  const values = new Map<Step, string>();
  const ask: { step: Step; key: ProfileKey | undefined; field: LoginField }[] = [];
  // A saved login for this site fills its sign-in fields. Not on a form that creates a password (two password
  // boxes): that is a signup, and the saved login belongs to the account that already exists.
  let login: Record<string, string> | undefined;
  // An autofill of a sign-in form asks, with the saved values shown. Several accounts are a choice, and the chosen one
  // fills the page. One account is shown so its email or password can be changed. A different email is stored as a new
  // account; the same email with a new password replaces that account.
  let confirmSignIn = false;
  if (fields.filter(field => field.password).length <= 1) {
    const accounts = (await savedLoginsForSite(ctx.stateDir, page.url()).catch(() => [])).filter(account => !account.rejected);
    const accountField = fields.some(field => loginValueFor({ username: 'x', password: 'x' }, field));
    // Google's first page is only the email box. That is still a sign-in, and the email has to be asked.
    const signIn = accountField && (fields.filter(field => field.password).length === 1 || /signin|identifier|\/login\b/i.test(page.url()));
    if (accounts.length && accountField) {
      let account = accounts.length === 1 ? accounts[0] : accounts.find(candidate => candidate.id === profileChoice.get(`${ctx.stateDir}|login|${origin}`));
      // Several logins and the profile's email names one of them: that is the account, with no question.
      const own = profile?.fields.sso_email ?? profile?.fields.email;
      if (!account && own) account = accounts.find(candidate => candidate.label.split(' · ').some(value => value.toLowerCase() === own.toLowerCase()));
      if (!account && ctx.requestPrivateLogin) {
        const labels = accounts.map(candidate => candidate.label);
        const answer = await ctx.requestPrivateLogin(origin, [{ index: -1, key: 'account', label: 'Sign in with which account?', kind: 'choice', required: true, options: [...labels, 'Enter a different one'] }], ctx.signal);
        account = accounts[labels.indexOf(answer?.account ?? '')];
        if (account) profileChoice.set(`${ctx.stateDir}|login|${origin}`, account.id);
      }
      if (account) login = await savedLoginFields(ctx.stateDir, page.url(), account.id).catch(quiet('agent/tools/computer-web'));
    }
    // A sign-in shows what it would fill, to edit or leave alone, instead of typing it unseen.
    if (signIn) confirmSignIn = true;
  }
  // A signup form (two password boxes, a new-password box, or a sign-up page): one strong password for the whole form
  // (see below), kept in Secrets Manager with the login, never shown.
  const passwordFields = fields.filter(field => field.password);
  // A form filled one box per call shows only one password box here, so the page itself is asked how many it has.
  const boxesOnPage = passwordFields.length ? await page.locator('input[type="password"]:visible').count().catch(() => 0) : 0;
  // A /login page is a sign-in even when the page has a second password box. Treating that as a signup would skip the
  // confirm prompt and fill the profile email with no chance to change it.
  const loginPage = /\/login\b|signin|identifier/i.test(page.url());
  const signingUp = !loginPage && (passwordFields.length >= 2 || boxesOnPage >= 2 || passwordFields.some(field => /new-password/i.test(field.hint.autocomplete))
    || (passwordFields.length > 0 && /sign[-_ ]?up|register|create[-_ ]?account|join|password\/(?:edit|new|reset)|(?:reset|set|new|change)[-_ ]?password/i.test(page.url())));
  // A sign-up gets a password of its own for this site, like a phone's "Strong Password": the one already typed into this
  // form (filled box by box), else the one saved for this site and email, else a new one that fits what the page asks.
  // The profile's `password` secret is only a fallback for when generating is switched off.
  const email = profile?.fields.sso_email ?? profile?.fields.email ?? fields.find(field => !field.password && field.current.includes('@'))?.current
    ?? steps.find(step => step.do === 'fill' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(step.text ?? ''))?.text;
  let generated: string | undefined;
  let policy: Awaited<ReturnType<typeof readPasswordPolicy>> | undefined;
  let mine = false;
  if (signingUp) {
    generated = pendingSignupPassword(page);
    if (generated) mine = generatedFor(page)?.password === generated;
    // The vault keeps logins for https sites only, and a password that cannot be kept is not worth making.
    if (!generated && page.url().startsWith('https:') && await generatedPasswordsAllowed(ctx.stateDir)) {
      policy = await readPasswordPolicy(page);
      generated = await savedPasswordFor(ctx.stateDir, page.url(), email) ?? generatePassword(policy);
      mine = true;
    }
    generated ??= profile ? await readProfileSecret(ctx.stateDir, profile, PASSWORD_SECRET) : undefined;
  }
  // A code split over single-character boxes (6 boxes, maxlength 1 each): one emailed code, one digit per box.
  const split = splitCodeFields(fields);
  if (split.length) {
    const code = await codeFromMailbox(ctx.stateDir, page.url(), Date.now() - 120_000, ctx.signal);
    if (code && code.length === split.length) { registerSecret(code); split.forEach((field, index) => values.set(field.step, code[index]!)); }
  }
  for (const field of fields) {
    if (values.has(field.step)) continue;
    if (field.password && generated) { values.set(field.step, generated); continue; }
    const fromLogin = login ? loginValueFor(login, field) : undefined;
    if (fromLogin && !(confirmSignIn && !signingUp)) { values.set(field.step, fromLogin); continue; }
    // A password box on a page that is not a sign-up (confirm your password to verify an email, re-enter it) is for the password this
    // site's account was made with: the one typed into this page's form, else the one saved for this site. The profile's own `password`
    // secret is never what a site with a generated password wants.
    if (field.password && !(confirmSignIn && !signingUp)) {
      const own = await sitePasswordFor(ctx.stateDir, page, email);
      if (own) { registerSecret(own); values.set(field.step, own); continue; }
    }
    // A secret kept with the profile (never shown to the agent) fills the box it is for: the password, a recovery code.
    const secretKey = secretFieldFor(profile, field.hint);
    const secret = secretKey && profile && !(confirmSignIn && !signingUp && field.password) ? await readProfileSecret(ctx.stateDir, profile, secretKey) : undefined;
    if (secret) { registerSecret(secret); values.set(field.step, secret); continue; }
    // A detail the agent asked for by name ("Support email") is more specific than the standard field its words also suggest.
    const asked = field.password ? undefined : customFieldFor(profile, field.hint);
    if (asked) { values.set(field.step, asked.field.value); continue; }
    // A lone one-time-code box is filled from the emailed code when a mailbox is connected: the right sender, once, no agent call.
    if (!field.password && fields.length === 1 && /one-time-code|\b(?:otp|verification|security code|passcode|confirmation code)\b|\bcode\b/i.test(`${field.hint.autocomplete} ${field.label} ${field.placeholder}`)) {
      const code = await codeFromMailbox(ctx.stateDir, page.url(), Date.now() - 120_000, ctx.signal);
      if (code) { registerSecret(code); values.set(field.step, code); continue; }
    }
    const key = field.password ? undefined : profileKeyFor(field.hint);
    const known = key ? profile?.fields[key] : undefined;
    if (confirmSignIn && !signingUp && (field.password || fromLogin || key === 'email')) {
      const current = field.password ? fromLogin : (fromLogin ?? known);
      ask.push({ step: field.step, key: undefined, field: { index: ask.length, key: `fill${ask.length}`, label: field.label || String(field.step.target), kind: field.password ? 'password' : 'text', required: true, ...(current ? { current } : {}) } });
      continue;
    }
    if (known) { values.set(field.step, key === 'phone' ? phoneFor(known, field.placeholder, field.current) : key === 'birthday' ? birthdayFor(known, `${field.label} ${field.placeholder}`) : known); continue; }
    ask.push({ step: field.step, key, field: { index: ask.length, key: `fill${ask.length}`, label: field.label || String(field.step.target), kind: field.password ? 'password' : 'text', required: true } });
  }
  if (generated) {
    registerSecret(generated);
    await holdSignup(ctx.stateDir, page, generated, email);
    if (mine) rememberGenerated(page, generated, policy ?? await readPasswordPolicy(page));
  }
  if (ask.length) {
    // A sign-in password with no saved login for this site and none in the profile cannot be made up: say so and park
    // it (in the queue, with the reason) rather than failing, so the run goes on to the next site.
    const needPassword = ask.filter(item => item.field.kind === 'password').map(item => item.field);
    const noPassword = (): Promise<never> => park(ctx.stateDir, page.url(), needPassword, 'no saved login for this site; sign in once with the login action or add one with `clikcode computer secrets --import`');
    if (!ctx.requestPrivateLogin) { if (needPassword.length) return noPassword(); throw new Error('Fill needs text: this chat cannot ask the user privately.'); }
    const answers = await ctx.requestPrivateLogin(origin, ask.map(item => item.field), ctx.signal);
    if (!answers) { if (needPassword.length) return noPassword(); throw new Error('The user did not answer the private prompt, so these fields were left empty.'); }
    const learned: Partial<Record<ProfileKey, string>> = {};
    for (const item of ask) {
      const answer = answers[item.field.key] ?? '';
      values.set(item.step, answer);
      // A password typed into a form shows in the page's own text afterwards: hold it back from every view.
      if (item.field.kind === 'password' && answer) { registerSecret(answer); expectSignup(page, answer); }
      else if (item.key && answer) learned[item.key] = answer;
    }
    if (Object.keys(learned).length && (profile || profiles.length === 0)) await saveProfile(ctx.stateDir, { ...(profile ? { id: profile.id } : {}), fields: learned });
    if (confirmSignIn && !signingUp) {
      const entered: Record<string, string> = {};
      for (const item of ask) {
        const answer = values.get(item.step);
        if (!answer) continue;
        if (item.field.kind === 'password') entered.password = answer;
        else if (!entered.username) entered.username = answer;
      }
      // Same email replaces that account's password. A different email is a new account.
      if (entered.username && entered.password) await saveLoginFields(ctx.stateDir, page.url(), entered).catch(quiet('agent/tools/computer-web'));
    }
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
export async function runSteps(page: Page, steps: readonly Step[], ctx: ToolContext, tab?: string, profileLabel?: string, guard?: (page: Page) => Promise<string | undefined>): Promise<ToolRunResult> {
  const notes: string[] = [];
  let current = page;
  steps = await askForFills(page, steps, ctx, profileLabel);
  for (const [index, planned] of steps.entries()) {
    // A later fill of the same batch still carries a generated password the site has since refused: it gets the current one.
    const held = generatedFor(current);
    const step = planned.do === 'fill' && held && planned.text && held.past.has(planned.text) ? { ...planned, text: held.password } : planned;
    // Only a tab the chat's own page opens is followed; another chat's tabs are not this chat's business.
    const popups: Page[] = [];
    const onPopup = (popup: Page): void => { popups.push(popup); };
    current.on('popup', onPopup);
    let halted = false;
    try {
      // Steps are journaled for an automatic recipe (see recipe-recorder.ts); a replay is not journaled again.
      const before = guard ? undefined : { url: current.url(), label: await controlName(current, step.target) };
      const done = await doStep(current, step, ctx);
      // A step a recipe cannot replay by control text (right-click, a canvas position, a drag) leaves the journal unsaved rather than wrong.
      if (before && typeof done === 'string') {
        const replayable = PLAIN_STEPS.has(step.do) && !(step.do === 'click' && (clickExtras(step) || step.x !== undefined));
        noteStep(journalKey(ctx.stateDir, tab), before.url, replayable ? step as Parameters<typeof noteStep>[2] : { do: 'click' }, replayable ? before.label : undefined);
      }
      if (typeof done === 'string') notes.push(done); else { notes.push(done.note); halted = true; }
      // A box the step raised holds the page: nothing can be read from it until the agent answers.
      if (step.do === 'press' || step.do === 'choose' || step.do === 'upload') await current.waitForTimeout(150);
      const waiting = pendingDialogNote(current);
      if (waiting) { notes.push(waiting); halted = true; }
      else {
        await settle(current);
        notes.push(...await downloadNotes(current));
        const saved = await settleSignup(ctx.stateDir, current);
        if (saved) notes.push(saved);
        // The site refused the password just made (an error about length, characters or symbols next to the box): another,
        // under looser rules, is typed in and the form sent again, up to three tries in all. Nothing of it reaches the model.
        const made = generatedFor(current);
        if (made && pendingSignupPassword(current) === made.password) {
          const stepPage = current;
          const retried = await retryRejectedPassword({ stateDir: ctx.stateDir, page: stepPage, username: pendingSignupUsername(stepPage),
            ...(step.do === 'click' || (step.do === 'press' && step.key === 'Enter') ? { resubmit: () => doStep(stepPage, step, ctx) } : {}), settle });
          if (retried) notes.push(retried);
        }
      }
    } catch (error) {
      // The page closing itself (a sign-in popup that finished) is read from the page, not from an error message.
      if (current.isClosed()) {
        const live = current.context().pages().filter(item => !item.isClosed()).at(-1);
        if (live) { current = live; adoptPage(ctx.stateDir, current, tab); halted = true; notes.push(`Step ${index + 1} (${step.do}): the tab closed itself, so this is the page that is open now.`); }
      }
      if (!halted) {
        // What changed, not the whole page again: a failed step in a long batch used to repeat thousands of tokens.
        const view = hasPendingDialog(current) ? undefined : await observeComputerPage(current, false, false, undefined, true).catch(quiet('agent/tools/computer-web'));
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
    // A replay looks at the page each step lands on (after any new tab is followed) and stops for a person's page.
    if (guard && !halted && await guard(current).catch(quiet('agent/tools/computer-web'))) halted = true;
    if (halted) {
      const rest = steps.length - index - 1;
      if (rest > 0) notes.push(`${rest} later step${rest === 1 ? ' was' : 's were'} not run.`);
      break;
    }
  }
  if (hasPendingDialog(current)) return { output: notes.join('\n') };
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
  if (url.hostname !== 'accounts.google.com') {
    // A sign-in or sign-up page: say which way in to take (Google, else GitHub, else the profile's email and password).
    const text = await page.evaluate(() => (globalThis as unknown as { document: { body: { innerText: string } } }).document.body.innerText.slice(0, 20_000)).catch(() => '');
    const hint = signInMethodHint({ ...signInProviders(text), email: /\b(?:sign ?in|log ?in)\b/i.test(text) && /\be-?mail\b/i.test(text) && /\bpassword\b/i.test(text) });
    return hint ? { ...result, output: `${result.output}\n\n${hint}` } : result;
  }
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

/** Which "continue with" providers a page's text offers. */
export function signInProviders(text: string): { google: boolean; github: boolean } {
  const offers = (name: string) => new RegExp(`(?:continue|sign ?(?:in|up)|log ?in|register)\\s+(?:in\\s+)?(?:with|using|via)\\s+${name}\\b`, 'i').test(text);
  return { google: offers('google'), github: offers('github') };
}

/**
 * The way in to take on a sign-in or sign-up page, in the user's order: Google (no password, no email check), else
 * GitHub, else the profile's email and password. Nothing is said about a page that offers neither.
 */
export function signInMethodHint(offered: { google: boolean; github: boolean; email?: boolean }): string | undefined {
  if (offered.google) return 'This page offers Google: use it ("Continue with Google" / "Sign in with Google") instead of a password or a new account; the account chooser follows.';
  if (offered.github) return 'This page offers GitHub and not Google: use "Continue with GitHub" (including when it is the one marked "Last used"). GitHub has no Google sign-in of its own: if GitHub asks to sign in, use login with the saved GitHub account, and read any verification code with read_email_code.';
  if (offered.email) return 'This page offers neither Google nor GitHub: sign in with the profile email (login action).';
  return undefined;
}

/** A navigation retried through a changing network (a laptop or tailnet switching routes fails a page load with ERR_NETWORK_CHANGED). */
async function withNetworkRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await run(); }
    catch (error) {
      if (attempt >= 3 || !(error instanceof Error) || !/ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_IO_SUSPENDED/.test(error.message)) throw error;
      await new Promise(resolve => setTimeout(resolve, 1_500 * (attempt + 1)));
    }
  }
}

/** The newest message matching from/subject in the signed-in Gmail, opened; its body. Waits for one that has just been sent. */
async function openLatestEmail(page: Page, args: WebArgs, stateDir: string): Promise<Locator> {
  if (!args.from && !args.subject) throw new Error(`${args.action} needs from or subject.`);
  // The mailbox is the profile's sign-in account (every sign-up used it), not whichever Gmail happens to be first.
  const mailbox = args.account ?? (await listProfiles(stateDir)).map(profile => profile.fields.sso_email).find(Boolean) ?? 0;
  const query = [args.from ? `from:(${args.from})` : '', args.subject ? `subject:(${args.subject})` : '', 'newer_than:1d'].filter(Boolean).join(' ');
  await withNetworkRetry(() => page.goto(`https://mail.google.com/mail/u/${mailbox}/#search/${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 30_000 }));
  const row = page.locator('tr.zA').first();
  // A message just sent may not be indexed yet: look again a few times before saying it is not there.
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await row.waitFor({ timeout: 10_000 }).then(() => true, () => false)) break;
    if (attempt === 3) throw new Error(`No email matched ${query}. If Gmail asked to sign in, sign in first with login; use account to pick another Gmail /u/N.`);
    await withNetworkRetry(() => page.reload({ waitUntil: 'domcontentloaded' }));
  }
  // Gmail's search defaults to "most relevant", which is not the newest: a reset link from an hour ago can come first.
  const relevant = page.getByRole('button', { name: /showing most relevant/i });
  if (await relevant.count()) {
    await relevant.first().click({ timeout: 3_000 }).catch(quiet('agent/tools/computer-web'));
    await page.getByRole('menuitemradio', { name: /most recent/i }).click({ timeout: 3_000 }).catch(quiet('agent/tools/computer-web'));
    await page.waitForTimeout(800);
  }
  await row.click();
  // Gmail folds a thread to its first message and its unread ones: expand them all, so the last body is the newest
  // message (a reset link from five minutes ago, not the stale one from the start of the thread).
  await page.locator('[aria-label="Expand all"]').first().click({ timeout: 2_000 }).catch(quiet('agent/tools/computer-web'));
  const body = page.locator('.a3s:visible').last();
  await body.waitFor({ timeout: 15_000 });
  await page.locator('.ajR').last().click({ timeout: 1_500 }).catch(quiet('agent/tools/computer-web')); // "show trimmed content"
  return body;
}

/** A line for a page's host when a recipe is saved for it, so an agent does not rediscover the signup. */
async function listRecipesFor(stateDir: string, url: string): Promise<string> {
  try {
    const recipes = (await listRecipes(stateDir)).filter(r => { const host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); return host === r.host || host.endsWith(`.${r.host}`); });
    return recipes.length ? `A recipe is saved for this site (${recipes.map(r => `via ${r.loginRoute}`).join(', ')}, verified ${recipes[0]!.verifiedAt.slice(0, 10)}): browser_use action recipe, recipe_op run replays it and stops at a captcha, code, payment or review page; recipe_op get shows its steps.` : '';
  } catch { return ''; }
}

/** The pointer, scroll and wait options of a call, as a step carries them. */
function stepExtras(args: WebArgs): StepExtras {
  const out: StepExtras = {};
  for (const name of ['button', 'count', 'modifiers', 'x', 'y', 'to_x', 'to_y', 'to_target', 'amount', 'until', 'selector', 'url'] as const) if (args[name] !== undefined) Object.assign(out, { [name]: args[name] });
  return out;
}

async function act(page: Page, args: WebArgs, ctx: ToolContext): Promise<ToolRunResult> {
  if ((PAGE_ACTIONS as readonly string[]).includes(args.action)) return pageAction(page, args, { stateDir: ctx.stateDir, ...(args.tab ? { tab: args.tab } : {}), acceptsImages: ctx.acceptsImages === true, locate, settle, displayUrl, view: (shown, compact) => observeComputerPage(shown, ctx.acceptsImages === true, false, undefined, compact === true) });
  if (INTERACTIONS.has(args.action)) {
    const one: Step = { do: args.action as Step['do'], ...stepExtras(args), ...(args.at ? { at: args.at } : {}), ...(args.target ? { target: args.target } : {}), ...(args.text !== undefined ? { text: args.text } : {}), ...(args.key ? { key: args.key } : {}), ...(args.direction ? { direction: args.direction } : {}), ...(args.accept_dialog ? { accept_dialog: true } : {}), ...(args.gone ? { gone: true } : {}), ...(args.seconds ? { seconds: args.seconds } : {}) };
    return runSteps(page, [one], ctx, args.tab, args.label);
  }
  switch (args.action) {
    case 'open': {
      // An address that is a file download does not navigate: the file is saved and reported instead.
      // Leaving the page was asked for, so a "leave this page?" box is accepted.
      const { result: isDownload } = await withDialogs(page, true, () => withNetworkRetry(() => page.goto(webAddress(args.url), { waitUntil: 'domcontentloaded', timeout: 30_000 })).then(() => false, error => { if (error instanceof Error && /Download is starting/i.test(error.message)) return true; throw error; }), 0);
      if (isDownload) { const got = await downloadNotes(page, 30_000, true); return { output: got.length ? got.join('\n') : 'The address is a file download, but nothing was saved.' }; }
      await settle(page);
      await settleSignup(ctx.stateDir, page);
      beginJournal(journalKey(ctx.stateDir, args.tab), page.url());
      const seen = await observeComputerPage(page, ctx.acceptsImages === true);
      const notes = await readSiteNotes(ctx.stateDir, new URL(page.url()).hostname).catch(() => '');
      const recipes = await listRecipesFor(ctx.stateDir, page.url());
      const withNotes = notes ? { ...seen, output: `Notes from earlier on this site:\n${notes}\n\n${seen.output}` } : seen;
      return recipes ? { ...withNotes, output: `${recipes}\n\n${withNotes.output}` } : withNotes;
    }
    case 'notes': {
      const host = args.host?.trim() || new URL(page.url()).hostname;
      if (!args.note) return { output: (await readSiteNotes(ctx.stateDir, host)) || `No notes for ${host} yet.` };
      return { output: `Saved. Notes for ${host}:\n${await addSiteNote(ctx.stateDir, host, args.note)}` };
    }
    case 'recipe': {
      const op = args.recipe_op ?? 'list';
      const host = args.host?.trim() || (() => { try { return new URL(page.url()).hostname; } catch { return ''; } })();
      if (op === 'list') { const all = await listRecipes(ctx.stateDir); return { output: all.length ? all.map(r => `${r.host} via ${r.loginRoute} (${r.steps.length} steps, verified ${r.verifiedAt.slice(0, 10)})`).join('\n') : 'No recipes saved yet.' }; }
      if (op === 'save') {
        const list = typeof args.steps === 'string' ? (() => { try { return JSON.parse(args.steps) as unknown; } catch { return undefined; } })() : args.steps;
        const saved = await saveRecipe(ctx.stateDir, { host, loginRoute: args.login_route ?? '', steps: list, ...(args.key_page ? { keyPage: args.key_page } : {}), ...(args.capture_hint ? { captureHint: args.capture_hint } : {}) });
        return { output: `Saved the recipe.\n${describeRecipe(saved)}` };
      }
      const recipe = await getRecipe(ctx.stateDir, host, args.login_route);
      if (!recipe) return { output: `No recipe for ${host}${args.login_route ? ` via ${args.login_route}` : ''} yet.`, ...(op === 'run' ? { isError: true } : {}) };
      if (op === 'get') return { output: describeRecipe(recipe) };
      // run: the existing steps runner, one page-look after every step. Recipes name controls by text, so nothing depends on a stale ref.
      let ended: Page = page;
      const mine = (await listProfiles(ctx.stateDir)).map(profile => profile.fields.sso_email).find(Boolean);
      const filled = { ...recipe, steps: recipe.steps.map(step => ({ ...step, ...(step.target ? { target: fillPlaceholders(step.target, { sso_email: mine }) } : {}), ...(step.text ? { text: fillPlaceholders(step.text, { sso_email: mine }) } : {}) })) };
      const replay = await replayRecipe(filled, (steps, guard) => runSteps(page, steps as Step[], ctx, args.tab, args.label, async current => { ended = current; return guard(); }), async () => scrubSecrets(await ended.ariaSnapshot({ mode: 'ai', timeout: 8_000 } as never) as string));
      if (replay.completed) await saveRecipe(ctx.stateDir, { host: recipe.host, loginRoute: recipe.loginRoute, steps: recipe.steps, ...(recipe.keyPage ? { keyPage: recipe.keyPage } : {}), ...(recipe.captureHint ? { captureHint: recipe.captureHint } : {}) }).catch(quiet('agent/tools/computer-web'));
      return { output: replay.output, ...(replay.isError ? { isError: true } : {}) };
    }
    case 'dialog': {
      const said = await answerDialog(page, args.accept_dialog === true, args.text);
      await page.waitForTimeout(300);
      const next = pendingDialogNote(page);
      if (next) return { output: `${said}\n\n${next}` };
      return { output: `${said}\n\n${(await observeComputerPage(page, false, false, undefined, true)).output}` };
    }
    case 'observe': return observeComputerPage(page, ctx.acceptsImages === true, args.full === true, args.find);
    case 'steps':
      const list = typeof args.steps === 'string' ? (() => { try { return JSON.parse(args.steps) as Step[]; } catch { return undefined; } })() : args.steps;
      if (!Array.isArray(list) || !list.length) throw new Error('steps needs a list, e.g. [{"do":"click","target":"e5"}].');
      return runSteps(page, list, ctx, args.tab, args.label);
    case 'network': {
      // Does the steps (or just waits and reloads nothing) while recording the page's API calls: the vendor's own web app
      // shows the real endpoint, method and answer shape when documentation is thin. Header values are never shown.
      const list = typeof args.steps === 'string' ? (() => { try { return JSON.parse(args.steps) as Step[]; } catch { return undefined; } })() : args.steps;
      const { recordNetwork, describeCalls } = await import('../computer/network-capture.js');
      const { result, calls, dropped } = await recordNetwork(page, async () => Array.isArray(list) && list.length ? runSteps(page, list, ctx, args.tab, args.label) : (await page.waitForTimeout((args.seconds ?? 5) * 1000), undefined), { ...(args.find ? { find: args.find } : {}), ...(args.bodies ? { bodies: true } : {}) });
      return { output: `${result?.output ? `${result.output}\n\n` : ''}${describeCalls(calls, dropped)}`, ...(result?.isError ? { isError: true } : {}) };
    }
    case 'open_email_link': {
      if (await emailConnected(ctx.stateDir)) {
        const mail = await waitForEmail(ctx.stateDir, { from: args.from, subject: args.subject, ...(args.from || args.subject ? {} : { site: page.url() }), spam: true, consume: true, accept: args.from || args.subject ? (m => m.links.length > 0) : looksLikeLinkEmail, timeoutMs: (args.seconds ?? 90) * 1000, signal: ctx.signal });
        const real = mail.links.filter(href => !/unsubscribe|accounts\.google\.com|mail\.google\.com|privacy|terms/i.test(href));
        const wanted = args.link?.toLowerCase();
        const pick = wanted ? real.find(href => href.toLowerCase().includes(wanted)) : real[0];
        if (!pick) throw new Error(`The email has no ${wanted ? `link mentioning "${args.link}"` : 'usable link'}. Links found: ${real.slice(0, 5).map(displayUrl).join(', ') || 'none'}.`);
        await page.goto(pick, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await settle(page);
        return observeComputerPage(page, ctx.acceptsImages === true);
      }
      const body = await openLatestEmail(page, args, ctx.stateDir);
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
    case 'email_connect': {
      // One consent in this browser stores the mailbox in Secrets Manager; read_email_code and open_email_link then use the Gmail API.
      const email = (await listProfiles(ctx.stateDir)).map(profile => profile.fields.sso_email).find(Boolean);
      const done = await connectEmail(ctx.stateDir, page, { email, progress: line => line && ctx.emitOutput?.(line) });
      return { output: `Mailbox connected${done.email ? `: ${done.email}` : ''}. read_email_code and open_email_link now read mail directly and wait for it to arrive.` };
    }
    case 'oauth_connect': {
      const email = (await listProfiles(ctx.stateDir)).map(profile => profile.fields.sso_email).find(Boolean);
      const done = await oauthConnect(args.target?.trim() ?? '', page, { email, stateDir: ctx.stateDir, signal: ctx.signal, progress: line => line && ctx.emitOutput?.(line) });
      return { output: `Connected ${done.connector}: ClikDeploy shows an active connection. ${done.steps.filter(Boolean).join(' ')}` };
    }
    case 'read_email_code': {
      if (await emailConnected(ctx.stateDir)) {
        // The mail arrives when the vendor sends it: wait for it instead of looking once.
        const mail = await waitForEmail(ctx.stateDir, { from: args.from, subject: args.subject, ...(args.from || args.subject ? {} : { site: page.url() }), spam: true, consume: true, accept: args.from || args.subject ? (m => verificationCode(m.text) !== undefined) : looksLikeCodeEmail, timeoutMs: (args.seconds ?? 90) * 1000, signal: ctx.signal });
        const code = verificationCode(mail.text);
        if (!code) throw new Error(`The email from ${args.from ?? args.subject} has no code in it. It says: "${mail.text.replace(/\s+/g, ' ').slice(0, 160)}".`);
        return { output: `Code: ${code}. Type it into the page that asked for it.` };
      }
      // A one-time sign-up or sign-in code is short-lived and meant to be typed, so it is returned as text
      // (an API key never is). The page the code is for is left as it was: Gmail is read in a tab of its own.
      const mail = await page.context().newPage();
      try {
        const text = await (await openLatestEmail(mail, args, ctx.stateDir)).innerText();
        const code = verificationCode(text);
        if (!code) throw new Error(`The email from ${args.from ?? args.subject} has no code in it. It says: "${text.replace(/\s+/g, ' ').slice(0, 160)}".`);
        return { output: `Code: ${code}. Type it into the page that asked for it; it is already waiting in the tab you left.` };
      } finally { await mail.close().catch(quiet('agent/tools/computer-web')); }
    }
    case 'login': {
      const outcome = await loginComputerPage({ stateDir: ctx.stateDir, page, signal: ctx.signal, newAccount: args.new_account === true,
        mailCode: since => codeFromMailbox(ctx.stateDir, page.url(), since, ctx.signal),
        ask: async (site, fields, signal) => {
          // The profile's email and password secret answer a sign-in with no saved login; anything else is asked.
          const fromProfile = await profileLoginAnswers(ctx.stateDir, fields);
          if (fromProfile) return fromProfile;
          if (!ctx.requestPrivateLogin) throw new LoginError('This chat cannot show private login fields.');
          return ctx.requestPrivateLogin(site, fields, signal);
        }, onVerification: () => ctx.emitOutput?.('Approve the sign-in or finish verification in the open browser.\n') });
      const failed = outcome === 'unverified' || outcome === 'saved_login_rejected';
      if (outcome === 'signed_in' || outcome === 'session_reused') await recordVerified(ctx.stateDir, journalKey(ctx.stateDir, args.tab), { kind: 'login' }).catch(quiet('agent/tools/computer-web'));
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
      const triggerLabel = args.target ? (await controlName(page, args.target)) ?? (REF.test(args.target.trim()) ? undefined : args.target.trim()) : undefined;
      const name = args.secret_name?.trim() || `${new URL(page.url()).hostname.replace(/^www\./, '')}/key`;
      // The clipboard is one thing and a Copy button only works in the focused tab: captures take turns, each in front.
      const { length, shape, via, check, sent } = await inOrder('clipboard', async () => { await page.bringToFront().catch(quiet('agent/tools/computer-web')); return captureSecret({ ...(args.paste ? { paste: true } : {}), stateDir: ctx.stateDir, page, name, signal: ctx.signal,
        meta: { vendor: args.vendor ?? new URL(page.url()).hostname.replace(/^www\./, ''), owner: args.owner ?? (await listProfiles(ctx.stateDir))[0]?.fields.sso_email, ...(args.env ? { env: args.env } : {}) },
        ...(plan?.length ? { sendTo: plan } : {}),
        ...(args.target ? { trigger: async () => { await clickOrHint(await locate(page, args.target)); } } : {}),
        ...(args.target ? { readTarget: async () => { const element = await locate(page, args.target); return (await element.inputValue({ timeout: 1_000 }).catch(() => '')) || (await element.innerText({ timeout: 1_000 }).catch(() => '')); } } : {}),
        ask: async (secretName, hint, signal) => {
          if (!ctx.requestPrivateSecret) throw new LoginError('Not saved: this chat cannot show a private prompt, and the key could not be found on its own.');
          return ctx.requestPrivateSecret(secretName, hint, signal);
        } }); });
      const refused = check.verdict === 'rejected';
      let recipeLint: string[] = [];
      if (!refused) {
        const key = journalKey(ctx.stateDir, args.tab);
        if (triggerLabel) noteStep(key, page.url(), { do: 'click', target: triggerLabel });
        const saved = await recordVerified(ctx.stateDir, key, { kind: 'capture', url: page.url(), hint: `${triggerLabel ? `Click "${triggerLabel}" to make the key show, then capture_secret. ` : ''}Verified: ${check.verdict === 'works' ? 'the key works' : 'a key was found and stored'}.` }).catch(quiet('agent/tools/computer-web'));
        if (saved) recipeLint = lintRecipe(saved).map(finding => finding.message);
      }
      const lines = [
        `SAVED "${name}" in ClikCode Secrets Manager (${length} characters, ${shape}, taken from ${via}). You were not shown the key; if that does not match what you expected (an id where a secret should be), delete it and capture again.`,
        refused ? `NOT VERIFIED: ${check.detail}. It was kept because the site shows a new key only once, and it was NOT sent anywhere. Wait a minute, then send it with send_secret and check the result.`
          : check.verdict === 'works' ? `Checked: ${check.detail}.` : `Not checked: ${check.detail}.`,
        ...(recipeLint.length ? [`Recipe saved (tidied; the recorded steps are kept in the .bak file). Still to fix: ${recipeLint.join('; ')}.`] : []),
        ...sent.map(delivery => `${delivery.ok ? 'SENT' : 'NOT SENT'} - ${delivery.label}: ${delivery.message}`),
        ...(refused ? [] : sent.some(delivery => !delivery.ok) ? ['The key is still saved. Fix the cause, then send it again with send_secret.'] : sent.length ? [] : ['Nothing was sent anywhere: use send_to to send it on, or send_secret later.']),
      ];
      return { output: lines.join('\n'), ...(sent.some(delivery => !delivery.ok) ? { isError: true } : {}) };
    }
    case 'handoff': {
      // The link is returned at once; the handoff runs on, and a second handoff call waits for the user to finish.
      const handoffKey = args.tab ? `${ctx.stateDir}#${args.tab}` : ctx.stateDir;
      let running = handoffs.get(handoffKey);
      if (!running) {
        const stop = new AbortController();
        let resolveLink!: (link: string) => void; let failLink!: (error: Error) => void;
        const link = new Promise<string>((resolve, reject) => { resolveLink = resolve; failLink = reject; });
        link.catch(quiet('agent/tools/computer-web'));
        // The phone reaches this computer directly over the user's Tailscale network: no relay, no third party.
        const host = tailnetAddress();
        if (!host) throw new Error('A handoff needs this computer and your phone on the same Tailscale network, and this computer is not on one (no Tailscale address). Install Tailscale and sign in on both, or finish this step at the computer.');
        const done = runTailnetHandoff({ stateDir: ctx.stateDir, host, signal: stop.signal, onLink: resolveLink, ...(args.tab ? { tab: args.tab } : {}) })
          .then(() => ({ ok: true as const }), (error: unknown) => { failLink(error instanceof Error ? error : new Error(String(error))); return { ok: false as const, message: error instanceof Error ? error.message : String(error) }; })
          .finally(() => { handoffs.delete(handoffKey); });
        running = { link, done, stop };
        handoffs.set(handoffKey, running);
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
async function clickOrHint(target: Locator, at?: 'start' | 'end'): Promise<void> {
  try { await press(target, at); }
  catch (error) {
    if (!(error instanceof Error) || !/timeout/i.test(error.message)) throw error;
    throw new Error(`${error.message.split('\n')[0]} If a popup window or browser dialog is in front of the page, use computer_use to see and answer it.`);
  }
}
