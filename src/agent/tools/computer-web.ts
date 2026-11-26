/** Page-level browser actions in ClikCode's own Chrome profile. */
import { approach, holdMs } from '../computer/human-input.js';
import { pickLink, describeLink, type LinkPick } from '../computer/email-links.js';
import { lifecycle, quiet } from '../../runtime/lifecycle-log.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defineTool } from '../tool-contract.js';
import { passHumanCheck } from '../computer/human-check.js';
import { adoptPage, allTabs, arrivedPages, closeComputerPage, ownedPages, computerPage, moveTabToCloud, moveTabToLocal, moveTabFromProfile, moveTabToProfile, tabIsInCloud, openComputerPage, openNewComputerPage, recoverComputerPage } from '../computer/browser.js';
import { checkKey, clickExtras, clickWith, closeTab, dragStep, fillTarget, hoverStep, listTabs, PAGE_ACTIONS, PAGE_DESCRIPTION, PAGE_PARAMETERS, pageAction, scrollStep, waitForState, withScreenshot, type PageAction, type PageArgs, type ScrollDirection, type StepExtras } from '../computer/page-control.js';
import { COMPUTER_OFF, captchaSolvingAllowed, computerEnabled, generatedPasswordsAllowed, unattendedEnabled } from '../computer/settings.js';
import { MAX_TOOL_IMAGE_BYTES, sniffImage } from '../images.js';
import { findLabelledSecret, keyFieldValues, maskSensitive, sensitiveValues } from '../computer/sensitive-fields.js';
import { storeSecretTool } from './store-secret.js';
import { sharedState } from '../computer/shared-state.js';
import { CARD_APPROVAL_MS, cardFieldFor, cardValueFor, describeCard, describeSavedCard, listCards, readCardSecret, saveCard, cardExpired, type SavedCard } from '../computer/payment-cards.js';
import { forgetSavedLogins, savedLoginFields, savedLoginsForSite, saveLoginFields } from '../computer/credential-vault.js';
import { loginValueFor } from '../computer/login-fill.js';
import { FILL_DEADLINE_MS, FillTimeout, withFillDeadline, type FillClock } from '../computer/fill-deadline.js';
import { describeRecipe, destructiveStep, fillPlaceholders, getRecipe, listRecipes, replayRecipe, saveRecipe } from '../computer/signup-recipes.js';
import { addSiteNote, readSiteNotes } from '../computer/site-notes.js';
import { assertCustomKey, bestProfileFor, isUnfillable, customFieldFor, defaultProfile, describeProfile, listProfiles, profileEmail, PASSWORD_SECRET, PROFILE_KEYS, phoneFor, birthdayFor, profileKeyFor, profileValue, readProfileSecret, saveProfile, saveProfileSecret, secretFieldFor, type FieldHint, type FillKey, type ProfileKey } from '../computer/profiles.js';
import { holdSignup, pendingSignupPassword, pendingSignupUsername, savedPasswordFor, settleSignup, sitePasswordFor } from '../computer/signup-login.js';
import { generatePassword } from '../computer/password-policy.js';
import { generatedFor, readPasswordPolicy, rememberGenerated, retryRejectedPassword } from '../computer/password-retry.js';
import { loginComputerPage, loginOutcomeMessage } from '../computer/login-page.js';
import { LoginError } from '../computer/login-error.js';
import { type LoginField } from '../computer/login-fields.js';
import { isSecretRef, registerSecret, resolveSecretRef, scrubSecrets, showsSecret } from '../computer/secret-scrubber.js';
import { hideRecoveryCodes, otpauthIn, QR_TARGET, recoveryCodesIn, RECOVERY_TARGET } from '../computer/recovery-codes.js';
import { profileLoginAnswers } from '../computer/profile-login.js';
import { classifyPasswordPage, newPasswordPath, readPasswordPageContext, resetPasswordPage, signInPath } from '../computer/password-page.js';
import { Parked, park } from '../computer/parking.js';
import { hideKeyLikeText } from '../computer/secret-finder.js';
import { answerDialog, bindDialogs, dialogNote, hasPendingDialog, pendingDialogNote, settleWaitingDialog, withDialogNotices, withDialogs } from '../computer/page-dialogs.js';
import { ALL_ACTION_NAMES, elsewhere, listing, overview, paramsOf, specOf, toolNameOf, usage, type ToolKind } from '../computer/actions.js';
import { FILES_ENV_HELP, FILES_ENV_PARAMETERS, filesEnvLabel, type FilesEnvAction, type FilesEnvArgs } from '../computer/files-env-schema.js';
import { documentView, requestDocumentPages } from '../computer/document-text.js';
import { applyHttpAuth, clearHttpAuth, denyPermissionsFor, runCookies, runPdf, runPermissions, runViewport } from '../computer/files-env-actions.js';
import { approvedUploadPath, isUploadPath } from '../computer/upload-files.js';
import { bindDownloads, describeDownloads, downloadNotes } from '../computer/downloads.js';
import { SEND_TO_HELP, SEND_TO_SCHEMA } from './store-secret.js';
import { declaredAuthKind, declaredConnectionValues, destinationProblem, normalizeSendTo, type Destination } from '../computer/secret-destinations.js';
import { ACTIONABLE, collapseRepeats, condenseSnapshot } from './snapshot-condense.js';
import { REF, rememberRefs, resolveRef } from '../computer/page-refs.js';
import { chooseOption } from '../computer/page-choose.js';
import { followPopup, SIGN_IN_CLICK } from '../computer/google-popup.js';
import { captureSecret } from '../computer/secret-capture.js';
import { emailConnected, emailStatus, findEmail, loginAddresses } from '../computer/email-api.js';
import { codeFromMailbox, emailVerificationCode, passwordFromMailbox, looksLikeCodeEmail, looksLikeLinkEmail, verificationCode } from '../computer/email-code.js';
import { connectEmail } from '../computer/email-consent.js';
import { beginJournal, noteStep, recordVerified } from '../computer/recipe-recorder.js';
import { chooseValue, labelledCandidates } from '../computer/read-value.js';
import { whyBlank } from '../computer/why-blank.js';
import { deleteNamedSecret, saveNamedSecret } from '../computer/credential-vault.js';
import { VENDOR_MFA_DESTINATION } from '../computer/secret-destinations.js';
import { lintRecipe } from '../computer/recipe-tools.js';
import { oauthConnect } from '../computer/oauth-consent.js';
import { findTailnetAddress, runTailnetHandoff } from '../computer/tailnet-handoff.js';
import type { Frame, Locator, Page } from 'playwright-core';
import type { ToolContext, ToolRunResult } from '../tool-contract.js';
import { sleep } from '../../runtime/sleep.js';
import { StoppedError, throwIfStopped } from '../computer/stopped.js';
import { VOIP_REFUSED, askedCountries } from '../computer/phone-walls.js';

type Step = { do: 'click' | 'fill' | 'choose' | 'press' | 'scroll' | 'wait' | 'upload' | 'hover' | 'drag'; target?: string; at?: 'start' | 'end'; text?: string; key?: string; direction?: ScrollDirection; accept_dialog?: boolean; gone?: boolean; seconds?: number } & StepExtras;
type WebArgs = {
  /** help: an action name, or "guide". */
  topic?: string;
  action: 'open' | 'close' | 'observe' | 'click' | 'fill' | 'choose' | 'press' | 'scroll' | 'wait' | 'upload' | 'steps' | 'login' | 'handoff' | 'show' | 'capture_secret' | 'send_secret' | 'secrets' | 'accounts' | 'profile' | 'card' | 'open_email_link' | 'read_email_code' | 'read_sms_code' | 'email_connect' | 'oauth_connect' | 'notes' | 'recipe' | 'queue' | 'network' | 'read_value' | 'forget_login' | 'add_login' | 'cloud' | 'isolate' | 'human_check' | 'auth_code' | 'help' | 'hover' | 'drag' | PageAction | FilesEnvAction;
  tab?: string; at?: 'start' | 'end'; url?: string; host?: string; note?: string; recipe_op?: 'save' | 'get' | 'run' | 'list'; login_route?: string; key_page?: string; capture_hint?: string; target?: string; mfa_account?: string; text?: string; key?: string; direction?: ScrollDirection; steps?: Step[] | string; full?: boolean; find?: string; gone?: boolean; seconds?: number; accept_dialog?: boolean;
  new_account?: boolean; method?: string; secret?: string; to?: string; with?: Record<string, string> | string; values?: Record<string, string> | string; ask?: boolean; from?: string; subject?: string; link?: string; account?: number; address?: string; fields?: Record<string, string>; ask_fields?: Array<{ key: string; label: string; match?: string[]; optional?: boolean; format?: string; options?: string[]; secret?: boolean }>; custom?: Record<string, { label?: string; value: string; match?: string[] }>; label?: string; egress?: string; secret_name?: string; vendor?: string; owner?: string; env?: string; task?: { vendor: string; kind?: string; status?: string; reason?: string; note?: string; owner?: string }; bodies?: boolean; why_blank?: boolean; tasks?: boolean; task_status?: string; task_reason?: string; paste?: boolean; send_to?: Destination[] | Destination | string;
} & PageArgs & FilesEnvArgs;

/** What was opened (host and path only: the rest of a mailed link is its token) and the other links by text. */
function chosenNote(pick: LinkPick, opened: string): string {
  return `${opened} Chose ${pick.chosen.text.trim() ? `"${pick.chosen.text.trim().slice(0, 60)}" ` : ''}(${describeLink(pick.chosen)})${pick.others.length ? `; other links: ${pick.others.map(t => `"${t.slice(0, 40)}"`).join(', ')}. Pass link: "words" to open another` : ''}.`;
}
function webAddress(value: string | undefined): string {
  if (!value) throw new Error('Open needs a website URL.');
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Open needs an HTTP or HTTPS website URL without credentials.');
  return parsed.href;
}

const isStandardKey = (key: string): boolean => (PROFILE_KEYS as readonly string[]).includes(key);

/** Whether a value is on the page now, in any frame: in its text, a field, or its markup (a data attribute, a hidden input). */
export async function pageHolds(page: Page, value: string): Promise<boolean> {
  for (const frame of page.frames()) {
    const found = await frame.evaluate((wanted: string) => {
      const root = (globalThis as unknown as { document: { documentElement: { innerText?: string; outerHTML: string }; querySelectorAll(selector: string): ArrayLike<{ value?: string }> } }).document;
      if ((root.documentElement.innerText ?? '').includes(wanted) || root.documentElement.outerHTML.includes(wanted)) return true;
      return Array.from(root.querySelectorAll('input, textarea')).some(field => (field.value ?? '').includes(wanted));
    }, value).catch(() => false);
    if (found) return true;
  }
  return false;
}

/** What `target` points at: a [ref=eN] from the last view (any element, named or not, in any frame),
 * or visible text for the controls of a sign-in page, which are listed by name without references. */
export async function locate(page: Page, target: string | undefined): Promise<Locator> {
  const wanted = target?.trim();
  if (!wanted) throw new Error('Say what to act on: a [ref=…] from the page view, or its visible text.');
  if (REF.test(wanted)) return resolveRef(page, wanted);
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
  const page = target.page();
  // Where the middle of a label is a link ("I agree to the Terms"), the edge is the box: click there.
  if (at) {
    const box = await target.boundingBox({ timeout: 6_000 });
    if (box) {
      const position = { x: at === 'start' ? Math.min(6, box.width / 2) : Math.max(box.width - 6, box.width / 2), y: box.height / 2 };
      await approach(page, target, position);
      await target.click({ position, delay: holdMs(), timeout: 6_000 });
      return;
    }
  }
  // A checkbox or radio is toggled on the element itself: a pointer click at its centre can land on a link in
  // its label ("I agree to the Terms and Privacy Policy") and open that page instead. A real click on the box comes first
  // (a script's click is marked untrusted, which bot checks read); a box that is hidden behind its styling gets the script's.
  const toggle = await target.evaluate(node => { const input = node as unknown as { tagName: string; type?: string }; return input.tagName === 'INPUT' && (input.type === 'checkbox' || input.type === 'radio'); }, undefined, { timeout: 2_000 }).catch(() => false);
  if (toggle) {
    const before = await target.isChecked({ timeout: 1_000 }).catch(() => undefined);
    const spot = await approach(page, target);
    const clicked = spot ? await target.click({ position: spot, delay: holdMs(), timeout: 2_500 }).then(() => true, () => false) : false;
    const toggled = clicked && (before === undefined || await target.isChecked({ timeout: 1_000 }).catch(() => !before) !== before);
    if (!toggled) await target.evaluate(node => (node as unknown as { click(): void }).click(), undefined, { timeout: 3_000 });
    return;
  }
  const spot = await approach(page, target);
  try { await target.click({ ...(spot ? { position: spot } : {}), delay: holdMs(), timeout: 6_000 }); }
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
const OPEN_CAP = 12_000;
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
  return collapseRepeats(snapshot.split('\n'), { keep, minRun: keep + 2, optionsOnly: true }).join('\n');
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
    if (OVERLAY.test(line)) { const to = end(at); const base = indentOf(line); overlays.push(...collapseRepeats(lines.slice(at, to).map(item => item.slice(base)))); at = to; continue; }
    if (!full && hasMain && (EDGE.test(line) || (SIDE_MENU.test(line) && end(at) - at > LONG_MENU_LINES))) { folded = true; at = end(at); continue; }
    kept.push(line); at++;
  }
  const cap = full ? 40_000 : 14_000;
  let body = full ? kept.join('\n') : condenseSnapshot(kept.join('\n'));
  // A dialog is the thing to act on: the page behind it is a few lines of context, not a second copy of the site.
  if (!full && overlays.length && kept.length > BEHIND_DIALOG_LINES) {
    const rows = body.split('\n');
    body = [...rows.slice(0, BEHIND_DIALOG_LINES), `- (… ${rows.length - BEHIND_DIALOG_LINES} more lines of the page behind the dialog; observe with full: true to see them)`].join('\n');
  }
  if (body.length > cap) {
    const rows = body.split('\n');
    let head = 0; let headSize = 0;
    while (head < rows.length && headSize < cap * 0.65) headSize += rows[head++]!.length + 1;
    let tail = rows.length; let tailSize = 0;
    while (tail > head && tailSize < cap * 0.35) tailSize += rows[--tail]!.length + 1;
    // What is cut from the middle is the text and links; its forms and buttons stay.
    const middle = rows.slice(head, tail);
    const controls = middle.filter(row => ACTIONABLE.test(row));
    body = [...rows.slice(0, head), `- (… ${middle.length - controls.length} lines trimmed from the middle of a long page (text and links only; its forms and buttons are kept); scroll, or observe with full: true …)`, ...controls.slice(0, 120), ...rows.slice(tail)].join('\n');
  }
  // What is open is shown before the page, and whole, up to a limit: a list no folding could shorten must not cost a page of text on every call.
  let open = overlays.join('\n');
  if (!full && open.length > OPEN_CAP) {
    const rows = open.slice(0, OPEN_CAP).split('\n').slice(0, -1);
    open = [...rows, `- (… ${overlays.length - rows.length} more lines of what is open; observe with find: "words" for a part of it, or full: true for all of it)`].join('\n');
  }
  return [open ? `Open now (dialogs and menus):\n${open}\n` : '', body, folded ? '- (header, footer and long side menus folded away; observe with full: true to see them)' : ''].filter(Boolean).join('\n');
}

/** Only the lines that mention `text`, each under the lines that contain it: for a page too long to read whole.
 * The words as a phrase first; when no line holds the phrase, any line that holds one of its words. */
export function findInSnapshot(snapshot: string, text: string): string {
  const lines = snapshot.split('\n');
  const lower = lines.map(line => line.toLowerCase());
  const phrase = text.trim().toLowerCase();
  const words = phrase.split(/\s+/).filter(word => word.length > 1);
  const whole = lower.some(line => line.includes(phrase));
  const mentions = (line: string): boolean => whole || words.length < 2 ? line.includes(phrase) : words.some(word => line.includes(word));
  const keep = new Set<number>();
  lines.forEach((line, at) => {
    if (!mentions(lower[at]!)) return;
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
  // A PDF or other document in the tab has no page to read: its text is fetched and returned instead.
  const document = await documentView(page);
  if (document) return { output: document };
  const raw = scrubSecrets(await maskSensitive(page, await page.ariaSnapshot({ mode: 'ai', timeout: 10_000 } as never) as string));
  // A key the page is showing is not for the model to read: capture_secret takes it.
  const keys = hideKeyLikeText(raw.replace(/^(\s*- \/url: )(\S{160})\S+$/gm, '$1$2…'));
  // Backup codes each sign in to the account: they are kept from the model like a key is.
  const codes = hideRecoveryCodes(keys.text);
  const shown = codes.hidden ? `${codes.text}\n\n[${codes.hidden} backup codes hidden. Save them all without reading them: capture_secret with target "backup codes".]` : codes.text;
  const hidden = keys.hidden;
  rememberRefs(page, shown);
  if (find?.trim()) {
    const found = findInSnapshot(shown, find.trim());
    return { output: `Page: ${displayUrl(page.url())}\n\n${found ? `Lines mentioning "${find.trim()}"${/\s/.test(find.trim()) && !shown.toLowerCase().includes(find.trim().toLowerCase()) ? ' (no line has the whole phrase; these have one of its words)' : ''}, with the elements around them:\n${found.slice(0, 12_000)}` : `Nothing on the page mentions "${find.trim()}". Try observe with full: true.`}` };
  }
  const before = lastSeen.get(page);
  lastSeen.set(page, { url: page.url(), shown });
  if (compact && !full && before && before.url === page.url()) {
    const changed = changedLines(before.shown, shown);
    if (changed) {
      const head = arrangeSnapshot(shown, false).split('\n\n')[0]!;
      const open = head.startsWith('Open now') ? `${head}\n\n` : '';
      const body = changed.count ? `Changed on the page (${changed.count} new or changed line${changed.count === 1 ? '' : 's'}; the rest is as before, observe for the whole page):\n${changed.text.slice(0, 8_000)}` : 'Nothing on the page changed (observe for the whole page).';
      return { output: `Page: ${displayUrl(page.url())}\n\n${open}${body}${hidden ? `\n\n[${hidden} key-like value${hidden === 1 ? '' : 's'} hidden. Use capture_secret to save it without reading it: target = the [secret:ref-N] placeholder, or the label beside it such as "API key".]` : ''}` };
    }
  }
  const snapshot = arrangeSnapshot(shown, full);
  const output = `Page: ${displayUrl(page.url())}\n\n${snapshot}${hidden ? `\n\n[${hidden} key-like value${hidden === 1 ? '' : 's'} hidden. Use capture_secret to save it without reading it: target = the [secret:ref-N] placeholder, or the label beside it such as "API key".]` : ''}`;
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

const ACTION_LIST = ALL_ACTION_NAMES.join(' · ');

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
    target: { type: 'string', description: 'oauth_connect: the ClikDeploy connector id (slack, github). click, fill, capture_secret: a [ref=…] from the page view (e5, or f1e2 inside a frame), or the visible text of a sign-in page control. forget_login: the site (a host such as wordnik.com, or a URL). auth_code: the field the code goes in.' },
    mfa_account: { type: 'string', description: 'auth_code: the vendor account whose authenticator seed is stored in ClikDeploy, e.g. "aws/root". Store the seed first with capture_secret to clikdeploy-vendor-mfa; only the rolling code comes back.' },
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
    values: { type: ['object', 'string'], additionalProperties: { type: 'string' }, description: 'send_secret to clikdeploy-connection: connection values ({org_api_key:"..."}, {app_id:"secret:<saved name>"}). oauth_connect: per-account sign-in address parts ({shop:"bobs-bikes"}).' },
    ask: { type: 'boolean', description: 'profile: ask the user now for name, email, phone and address and save them as a profile (also happens when none exists).' },
    from: { type: 'string', description: 'open_email_link, read_email_code, read_sms_code: the sender (or "any"); default: the site.' },
    subject: { type: 'string', description: 'open_email_link, read_email_code: words from the subject.' },
    link: { type: 'string', description: 'open_email_link: words or domain of the link to open (default: the first real link in the message).' },
    account: { type: 'integer', description: 'open_email_link, read_email_code: Gmail account number /u/N (default 0).' },
    address: { type: 'string', description: 'read_email_code, open_email_link: which connected mailbox to read (an email address). Default: the mailbox the page or the site\'s saved login used, else the profile email; after 20 s the others are tried. email_connect: the Google account to connect (default: the profile email); another account adds a mailbox, replacing none.' },
    fields: { type: 'object', additionalProperties: { type: 'string' }, description: `profile: fields to save or correct in the user's autofill profile (${PROFILE_KEYS.join(', ')}). Leave out to list the profiles. Use it when a site wants a different format (phone as +1…, state as an abbreviation).` },
    label: { type: 'string', description: 'read_value: the label the page shows beside the value ("Application ID", "Subdomain", "Workspace ID"). forget_login: only the saved login with this username or email (default: every saved login for the site). profile: which profile (default: the one called Personal, else the one with the most standard fields, else a new one called Personal). isolate: the separate Chrome profile\'s name (default "signup").' },
    egress: { type: 'string', description: 'isolate: the way out the separate profile leaves through and keeps (a name from clikcode computer egress list; "home": this computer\'s own connection). Default: the one it already keeps.' },
    ask_fields: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { key: { type: 'string' }, label: { type: 'string' }, match: { type: 'array', items: { type: 'string' } }, optional: { type: 'boolean' }, format: { type: 'string', description: 'Types itself as the user enters it: date (##/##/####), phone ((###) ###-####), zip, time, or a pattern where # is a digit, A a letter, * either and anything else a literal the box inserts and jumps over.' }, options: { type: 'array', items: { type: 'string' }, description: 'A fixed set of answers shown as a selector (arrow keys in the terminal, radios in VS Code) instead of a text box.' }, secret: { type: 'boolean', description: 'The answer is a secret (a password to use for sign-ups, key "password"; a recovery code): typed hidden, kept in Secrets Manager with the profile, and never shown to you. A later fill of a password box with no text uses it.' } }, required: ['key', 'label'] }, description: 'profile: ask the user, privately and in one prompt, for details a task needs beyond the standard ones, and keep them in a profile (with label, a new one) so every later fill with no text uses them. key is lower_snake_case (app_name, privacy_policy_url); label is what the user is asked; match lists the words a form may label it with (["app name","application name"]); optional fields may be left empty. Details only; a password or code goes in with secret: true.' },
    custom: { type: 'object', additionalProperties: { type: 'object', additionalProperties: false, properties: { label: { type: 'string' }, value: { type: 'string' }, match: { type: 'array', items: { type: 'string' } } }, required: ['value'] }, description: 'profile: save custom details you already know (a redirect address, the app name you chose) into a profile, same shape as ask_fields answers: {key: {label, value, match}}.' },
    vendor: { type: 'string', description: 'capture_secret: the vendor the key is for, recorded with it.' },
    owner: { type: 'string', description: 'capture_secret: the account the key or app belongs to (default: the profile\'s sign-in email).' },
    env: { type: 'string', description: 'capture_secret: production, sandbox or test.' },
    task: { type: 'object', additionalProperties: false, properties: { vendor: { type: 'string' }, kind: { type: 'string', enum: ['oauth-app', 'api-key', 'test-account', 'webhook', 'other'] }, status: { type: 'string', enum: ['queued', 'working', 'done', 'needs-human', 'blocked', 'no-self-serve'] }, reason: { type: 'string', enum: ['captcha', 'sms', 'email', 'payment', 'identity', 'review', 'two-factor', 'no-logo', 'unsupported-protocol', 'other'] }, note: { type: 'string' }, owner: { type: 'string' } }, required: ['vendor'], description: 'queue: record or update one vendor task (one per vendor and kind). Set status needs-human with a reason when a person must act (captcha, sms, payment), done when finished, blocked when it cannot be done. Always record the outcome here instead of only saying it.' },
    why_blank: { type: 'boolean', description: 'observe: for a page stuck on Loading... or blank (a sign-in button that never renders): reload it once and report the failed, blocked and error-status requests (third-party scripts marked), and the console errors. Bounded (seconds, default 12, up to 25). Record the cause instead of retrying.' },
    bodies: { type: 'boolean', description: 'network: also show request and answer bodies (truncated, key-like values hidden). Default: shapes only.' },
    tasks: { type: 'boolean', description: 'queue: list the tasks (filter with task_status, task_reason) with a summary.' },
    task_status: { type: 'string' }, task_reason: { type: 'string' },
    method: { type: 'string', description: 'accounts: the provider an OAuth sign-in went through (google, github, microsoft) when recording one.' },
    secret_name: { type: 'string', description: 'capture_secret: name to save the key under (default: the site\'s name plus "/key").' },
    send_to: { ...SEND_TO_SCHEMA, description: 'capture_secret: ' + SEND_TO_HELP },
    ...FILES_ENV_PARAMETERS,
  } };

const WEB_TEXT = [
    "Drive ClikCode's own Chrome (its own saved profile; it starts by itself). open and observe return the page, with a [ref=…] on each element: pass a ref as target (or visible text) to click or fill. After an action you get only what changed (and any open dialog); observe shows the whole page again. A new tab or popup the page opens is followed automatically.",
    'Actions: open (a URL) · observe (the page again; full: true adds header and footer; find: "words" shows only the lines that mention them, for a long page) · click · fill · choose (an option of a dropdown: target + text) · press · scroll · wait (for text to appear or go, up to 2 minutes; for jobs that finish on their own) · steps (several of those in order, one call, stops at the first failure) · login · handoff · capture_secret · profile · open_email_link (find the newest email from a sender in the signed-in Gmail and open a link in it, one call: verification and sign-in emails) · upload (a file input or its button + text: the name of a profile file detail ending _file such as logo_file, or the absolute path of a file in the workspace or the chat\'s downloads folder; nothing else can be sent) · notes (read or add what was learned on a site: the URL that worked, the order of screens, what was missing; shown again whenever a page on that host is opened, so write one when a task finally works) · recipe (save the steps of a signup or key capture that worked, by control text, never secrets; run replays them and stops for the user at a captcha, code, payment or review page; list) · email_connect (one consent in this browser connects the signed-in Gmail; after that read_email_code and open_email_link read mail through the Gmail API, wait for it to arrive, and return only the code or the link) · oauth_connect (target = a ClikDeploy connector id: starts its OAuth connect, presses through the vendor consent screens in this signed-in browser (account named by the profile sso_email, Advanced / Go to ... (unsafe), Continue / Allow / Authorize), stops with a plain reason at a login password, MFA code, captcha or an unknown screen (sign in first with login), and confirms ClikDeploy shows an active connection) · read_email_code (the one-time code in the newest email from a sender, read in a tab of its own, so a sign-up that wants an emailed code does not need the user) · add_login (one private form for email and password, saved as a login for the website in url; with no url it asks for the website too; label = the email it starts with) · forget_login (remove the saved login for a site from the vault: target = the site, label = one account; returns only a count; use it for a login the site keeps refusing) · close.',
    PAGE_DESCRIPTION,
    'Each chat has its own tab. The user\'s autofill profile (name, email, phone, address, and any custom details you asked for with profile ask_fields) fills forms for you: fill a field with no text and it is filled from the profile, or the user is asked once and the answer is kept. If a site wants another format, fill that field with the exact text, and save the corrected value with action profile and fields. When a site offers Continue/Sign in with Google and the browser is already signed in to Google, prefer it: no new password or email check. If it offers GitHub and not Google, use Continue with GitHub (sign in to GitHub with the saved login; there is no Google sign-in inside GitHub). Only when neither is offered, fill the form with no text: the profile email fills it, and on a sign-up every password box gets a strong password made up for that site (fitted to what the page asks, retried if the site refuses it, saved with the login, never shown to you); a later sign-in fills the saved login. Every page can be read, including sign-in and signup forms; the values of password, code and card fields are masked. For anything only the user knows (a password, a code, an address, a phone number), fill the field with no text: a saved login for the site or the profile fills it, else the user is asked privately, and you are not shown the answer. That is all a sign-in or signup needs: fill the fields, click Next, repeat. (login does the same in one action for a plain email-then-password sign-in.) Never ask for a password or code in chat. When a sign-in page offers different ways in (root or IAM, another account), ask the user with ask_user, click their choice, then login. handoff returns a link to a live view of the tab at once, for a CAPTCHA or MFA only the user can do (it opens on their phone or any device on their Tailscale network); give it to the user, then call handoff again to wait until they finish. When the user only wants to watch what you are doing, use show instead.',
    'Work through the whole task you were given without checking in at each step. Ask real choices (project, account, role set) once, up front, in one question; after that ask only when genuinely blocked (a sign-in they must type, a payment).',
    FILES_ENV_HELP,
    'API keys: go to the key page, set the options, then capture_secret with target = the final Create button and a send_to plan. It presses the site\'s Copy button or reads the file it hands over, checks the key against its service, saves it to ClikCode Secrets Manager and sends it where send_to says. You never see the key. With no target it takes a key the page already shows; never click Regenerate just to see one.',
  ];
const WEB_DESCRIPTION = WEB_TEXT.join('\n');

/** The engine behind both tools: every action, the whole schema. Not given to a model; browser_use and account_use below are what agents see. */
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
      case 'steps': return `${stepList(args)?.length ?? 0} steps on the page`;
      case 'login': return 'Sign in';
      case 'handoff': return 'Hand off to the user';
      case 'show': return args.clear ? 'Close the live view' : 'Show the tab to the user';
      case 'human_check': return 'Press the human check';
      case 'auth_code': return 'Type authenticator code';
      case 'cloud': return args.clear ? 'Back to the local browser' : 'Move tab to cloud browser';
      case 'isolate': return args.clear ? 'Back to the main profile' : `Isolate tab in profile ${args.label?.trim() || 'signup'}`;
      case 'capture_secret': return `Capture key${args.secret_name ? ` as ${args.secret_name}` : ''}`;
      case 'close': return 'Close browser';
      default: return filesEnvLabel(args) ?? `Web ${args.action}`;
    }
  },
  paths: (args) => uploadPaths(args),
  describe: async (args) => `ClikCode browser: ${args.action}${args.url ? ` ${args.url}` : ''}${args.target ? ` ${args.target}` : ''}${uploadPaths(args).length ? ` (sends ${uploadPaths(args).join(', ')})` : ''}${args.action === 'fill' ? ` (${args.text?.length ?? 0} characters)` : ''}${args.action === 'evaluate' ? `\nscript (in full):\n${args.expression ?? ''}` : ''}`,
  // One chat's browser calls run in the order they were made. The model can send two at once (a capture and
  // the click that closes the dialog it reads), and a one-time key does not survive that race.
  run: (args, hostCtx) => {
    // `profile` is what callers naturally write for `label` (the profile to use); it used to be ignored without a word.
    const profileAlias = (args as { profile?: unknown }).profile;
    if (typeof profileAlias === 'string' && profileAlias && !args.label) args.label = profileAlias;
    if (args.action === 'handoff') return handoffAction(args, hostCtx).catch((error: unknown) => ({ output: error instanceof Error ? error.message : String(error), isError: true }));
    if (args.action === 'show') return showAction(args, hostCtx).catch((error: unknown) => ({ output: error instanceof Error ? error.message : String(error), isError: true }));
    return runInOrder(args, hostCtx);
  },
});

/** What still makes sense when a new tab has just taken the front: looking at it, going somewhere, or picking another tab. */
const AFTER_NEW_TAB = new Set(['open', 'observe', 'screenshot', 'console', 'cookies', 'switch']);

function runInOrder(args: WebArgs, hostCtx: ToolContext): Promise<ToolRunResult> {
  return inOrder(args.tab ? `${hostCtx.stateDir}#${args.tab}` : hostCtx.stateDir, async (hold): Promise<ToolRunResult> => {
    // Unattended: a private prompt about a site (a password, a code, an account choice) is parked in the queue, not shown.
    // Missing profile details follow the same rule: no private dialog can suspend an unattended worker.
    const ctx: ToolContext = await unattendedEnabled(hostCtx.stateDir) && hostCtx.requestPrivateLogin
      ? { ...hostCtx, requestPrivateLogin: (site, fields) => park(hostCtx.stateDir, site, fields) }
      : hostCtx;
    try {
      if (!(await computerEnabled(ctx.stateDir))) throw new Error(COMPUTER_OFF);
      if (!ALL_ACTION_NAMES.includes(String(args.action))) throw new Error(`Unknown action "${String(args.action)}". Actions: ${ACTION_LIST}.`);
      if (args.action === 'send_secret') return storeSecretTool.run({ secret: args.secret ?? '', ...(args.to ? { to: args.to } : {}), ...(args.with ? { with: args.with } : {}), ...(args.values ? { values: args.values } : {}), ...(args.send_to ? { send_to: args.send_to } : {}) }, ctx);
      if (args.action === 'accounts') {
        const { allSavedLogins, saveSignInMethod } = await import('../computer/credential-vault.js');
        // Record how a site was signed in to when it went through a provider: accounts + target (the site) + method + fields.email.
        if (args.method) {
          const account = args.fields?.email ?? args.fields?.username ?? '';
          const id = await saveSignInMethod(ctx.stateDir, /^https?:/i.test(args.target ?? '') ? args.target! : `https://${args.target ?? ''}`, args.method.toLowerCase(), account);
          return { output: `Recorded: ${args.target} is signed in to with ${args.method} as ${account} (${id.slice(0, 8)}).` };
        }
        const words = (args.target ?? '').toLowerCase().split(/\s+/).filter(Boolean);
        const found = (await allSavedLogins(ctx.stateDir)).filter(login => words.every(word => `${login.name} ${login.baseUrl}`.toLowerCase().includes(word)));
        if (!found.length) return { output: words.length ? `No saved sign-in matches "${args.target}".` : 'No sign-ins are saved yet.' };
        const lines = found.slice(0, 150).map(login => `${login.name}  ${login.baseUrl}  ${login.method === 'password' ? 'password' : `via ${login.method}`}  ${login.label}${login.complete ? '' : '  (incomplete)'}`);
        return { output: `${found.length} saved sign-in${found.length === 1 ? '' : 's'}${found.length > lines.length ? `, first ${lines.length}; add words to target to narrow` : ''}. Passwords are never shown; login signs in with one.\n${lines.join('\n')}` };
      }
      if (args.action === 'secrets') {
        const { namedSecretInfo } = await import('../computer/credential-vault.js');
        const words = (args.target ?? '').toLowerCase().split(/\s+/).filter(Boolean);
        const found = (await namedSecretInfo(ctx.stateDir)).filter(({ name }) => words.every(word => name.toLowerCase().includes(word)));
        if (!found.length) return { output: words.length ? `No saved key matches "${args.target}". Capture one with capture_secret.` : 'No keys are saved yet. Capture one with capture_secret.' };
        const shown = found.slice(0, 150).map(({ name, meta }) => `${name}${meta ? `  ${meta.url ?? 'no site recorded'}  (saved ${meta.createdAt.slice(0, 10)}${meta.rotatedAt ? `, rotated ${meta.rotatedAt.slice(0, 10)}` : ''})` : ''}`);
        return { output: `${found.length} saved key${found.length === 1 ? '' : 's'}${found.length > shown.length ? `, first ${shown.length}; add words to target to narrow` : ''}. Values are never shown; send one on with send_secret.\n${shown.join('\n')}` };
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
      if (args.action === 'card') {
        // The person's saved payment cards. Adding one is a private prompt: the number and security code go from their keyboard
        // to Secrets Manager and are never in this chat. What comes back is what a wallet shows: brand, last four, expiry.
        // Removing a card is the person's own act (clikcode computer card --delete): an agent adds and lists, never deletes.
        if (args.ask) {
          if (!ctx.requestPrivateLogin) throw new Error('This chat cannot ask the user privately. The user can add a card themselves: clikcode computer card --add');
          if (await unattendedEnabled(hostCtx.stateDir)) throw new Error('A card is added by the user in person, not in an unattended run.');
          const answers = await ctx.requestPrivateLogin('https://card.clikcode', [
            { index: 0, key: 'number', label: 'Card number', kind: 'password', required: true },
            { index: 1, key: 'expiry', label: 'Expiry (MM/YY)', kind: 'text', required: true, format: '##/##' },
            { index: 2, key: 'code', label: 'Security code (leave empty to be asked each time)', kind: 'password', required: false },
            { index: 3, key: 'name', label: 'Name on card', kind: 'text', required: false },
          ], ctx.signal);
          if (!answers) throw new Error('The user did not enter a card.');
          registerSecret(answers.number ?? '');
          if (answers.code) registerSecret(answers.code);
          const saved = await saveCard(ctx.stateDir, { number: answers.number ?? '', expiry: answers.expiry ?? '', ...(answers.code ? { code: answers.code } : { code: '' }), ...(answers.name ? { name: answers.name } : {}), ...(args.label ? { label: args.label } : {}) });
          return { output: `Saved ${describeSavedCard(saved)}. Fill a payment form's boxes with no text to use it: the user approves each site, and you are never shown the number or the security code.` };
        }
        const cards = await listCards(ctx.stateDir);
        return { output: cards.length ? cards.map(card => describeSavedCard(card)).join('\n') : 'No payment card is saved. ask: true asks the user for one privately.' };
      }
      // Lists every worker's tabs, so it needs no tab of this chat's own.
      if (args.action === 'tabs') return { output: await listTabs({ stateDir: ctx.stateDir, ...(args.tab ? { tab: args.tab } : {}), displayUrl }) };
      if (args.action === 'close' && args.tab && args.index === undefined) {
        // A named tab is closed whoever holds it (a worker that ended left it), and each close is logged.
        const before = ((await allTabs(ctx.stateDir).catch(quiet('agent/tools/computer-web'))) ?? []).filter(view => view.tab === args.tab).length;
        await closeComputerPage(ctx.stateDir, args.tab);
        return { output: before > 1 ? `Closed ${before} tabs named "${args.tab}".` : `Closed the tab named "${args.tab}".` };
      }
      if (args.action === 'close' && (args.index !== undefined)) { await computerPage(ctx.stateDir, args.tab); return { output: await closeTab(args, { stateDir: ctx.stateDir, ...(args.tab ? { tab: args.tab } : {}) }) }; }
      if (args.action === 'close') { await closeComputerPage(ctx.stateDir, args.tab); return { output: 'This chat\'s tab is closed.' }; }
      if (args.action === 'auth_code') {
        // The six-digit code an authenticator app would show. The seed lives server-side in ClikDeploy
        // (stored once with capture_secret -> clikdeploy-vendor-mfa); ClikDeploy hands out only the
        // rolling code, never the seed. The code is typed straight into the field, never shown here.
        if (!args.mfa_account?.trim()) throw new Error('auth_code needs mfa_account: the vendor account the seed is stored under in ClikDeploy (e.g. "aws/root"). Store it first by capturing the key with capture_secret to the clikdeploy-vendor-mfa destination.');
        if (!args.target?.trim()) throw new Error('auth_code needs target: the field the code goes in.');
        const { vendorMfaCode } = await import('../computer/secret-destinations.js');
        const page = await computerPage(ctx.stateDir, args.tab);
        const field = await locate(page, args.target);
        const res = await vendorMfaCode(args.mfa_account.trim(), ctx.signal);
        if ('error' in res) throw new Error(`Could not get an authenticator code for "${args.mfa_account.trim()}" from ClikDeploy: ${res.error}`);
        await field.fill(res.code, { timeout: 10_000 });
        return { output: `Typed the current authenticator code for ${args.mfa_account.trim()} into ${args.target} (${res.secondsRemaining}s left on it). It was not shown to you, and ClikDeploy keeps the seed, not this machine. Call auth_code again for the next code if the site asks for two in a row.` };
      }
      if (args.action === 'human_check') {
        const page = await computerPage(ctx.stateDir, args.tab);
        // One press, then (when solving is on) the answer itself, in this signed-in tab: pictures of the challenge go
        // to the account's own Gateway models and their answer is played back at a visitor's pace -- built-in captcha
        // solving, no external service. A tab in the managed cloud browser is only pressed.
        const inCloud = tabIsInCloud(ctx.stateDir, args.tab);
        const solve = !inCloud && await captchaSolvingAllowed(ctx.stateDir);
        const checked = await passHumanCheck(page, { stateDir: ctx.stateDir, solve, ...(ctx.signal ? { signal: ctx.signal } : {}) });
        const next = 'Use handoff so the user can finish it.';
        return { output: checked.outcome === 'cleared' && checked.widget === 'text' ? 'The characters in the captcha picture were read and typed into its field. Send the form; if the site says the code was wrong, run human_check again on the new picture.'
          : checked.outcome === 'cleared' ? 'The human check was passed. Observe the page and carry on.'
          : checked.outcome === 'puzzle' ? `The check asks for a puzzle, and captcha solving is ${inCloud ? 'not run in the managed cloud browser' : 'turned off (clikcode computer captcha on)'}. ${next}`
          : checked.outcome === 'still-there' ? `The check was tried and did not clear (${checked.widget ?? 'unknown kind'}${checked.seen ? `: ${checked.seen}` : ''}). Observe the page and run human_check once more if a challenge is showing (a fresh one is often easier); after that, ${next.charAt(0).toLowerCase()}${next.slice(1)}`
          : 'No human check is on this page. Observe it: a whole-page check may still be loading, or the block is something else.' };
      }
      if (args.action === 'cloud') {
        if (args.clear === true) {
          const back = await moveTabToLocal(ctx.stateDir, args.tab);
          return { output: back.moved ? `This tab is back in the local browser${back.stopped ? ', and the cloud session is stopped' : ''}. Observe it to carry on.` : 'This tab was already in the local browser.' };
        }
        const { page: cloudPage, moved } = await moveTabToCloud(ctx.stateDir, args.tab);
        return { output: moved
          ? `This tab is now in the managed cloud browser at ${displayUrl(cloudPage.url())}. It is signed out there (local sign-ins are not copied) and does not answer captchas. Observe the page; if it still blocks you, use handoff. When done, close the tab or call cloud with clear: true, which stops the billed session.`
          : 'This tab is already in the managed cloud browser.' };
      }
      if (args.action === 'isolate') {
        if (args.clear === true) {
          const back = await moveTabFromProfile(ctx.stateDir, args.tab);
          return { output: back.moved ? `This tab is back in the main profile${back.from ? ` (the profile "${back.from}" is kept for next time)` : ''}. Observe it to carry on.` : 'This tab was already in the main profile.' };
        }
        const name = (args.label?.trim() || 'signup').toLowerCase();
        const egress = args.egress?.trim().toLowerCase() || undefined;
        const { page: profilePage, moved } = await moveTabToProfile(ctx.stateDir, name, args.tab, egress);
        const through = egress === undefined ? '' : egress === 'home' ? ' It leaves through this computer\'s own connection.' : ` It leaves through "${egress}" (its address, WebRTC and clock), and keeps that until isolate names another egress.`;
        return { output: moved
          ? `This tab is now in the separate profile "${name}" at ${displayUrl(profilePage.url())}, a Chrome of its own: none of the main profile's sign-ins are there, and what you sign into here stays here across sessions.${through} If the site refuses softly ("we ran into a problem", "unusual activity"), stop and tell the user; do not retry. Call isolate with clear: true to go back to the main profile.`
          : `This tab is already in the separate profile "${name}".${through}` };
      }
      if (args.action === 'add_login') {
        // One private form: the website, the email, the password. The way in (Google, GitHub or a site's own form) follows from the site.
        if (!ctx.requestPrivateLogin) throw new LoginError('This chat cannot show private login fields.');
        const known = defaultProfile(await listProfiles(ctx.stateDir));
        const email = (args.label ?? known?.fields.email ?? '').trim();
        // The agent names the website, so the form asks only for email and password; with no website given it asks for that too.
        const given = args.url?.trim();
        const answers = await ctx.requestPrivateLogin('https://profile.clikcode', [
          ...(given ? [] : [{ index: 0, key: 'website', label: 'Website', kind: 'text' as const, required: true, current: 'https://accounts.google.com/' }]),
          { index: 1, key: 'email', label: 'Email', kind: 'text' as const, required: true, ...(email ? { current: email } : {}) },
          { index: 2, key: 'password', label: 'Password', kind: 'password' as const, required: true },
        ], ctx.signal);
        if (!answers) throw new LoginError('No login was added: the form was closed.');
        const typed = (given || answers.website || '').trim();
        const site = /^https?:\/\//.test(typed) ? typed : `https://${typed}`;
        if (new URL(site).protocol !== 'https:') throw new LoginError('A login needs an https website.');
        // The same account added again (a new password) replaces its entry: two entries for one account would make every sign-in ask which.
        const same = (await savedLoginsForSite(ctx.stateDir, site)).find(login => login.label.toLowerCase() === answers.email!.trim().toLowerCase());
        await saveLoginFields(ctx.stateDir, site, { email: answers.email!.trim(), password: answers.password! }, same?.id);
        return { output: `Saved the login for ${new URL(site).hostname} as ${answers.email!.trim()}. Sign in there with the login action.` };
      }
      if (args.action === 'forget_login') {
        const site = args.target?.trim() || args.host?.trim() || args.url?.trim();
        if (!site) throw new Error('forget_login needs the site in target (a host such as wordnik.com, or a URL).');
        const count = await forgetSavedLogins(ctx.stateDir, site, args.label);
        return { output: count ? `Removed ${count} saved login${count === 1 ? '' : 's'} for ${site.replace(/^https?:\/\//, '').split('/')[0]}.` : `No saved login for ${site.replace(/^https?:\/\//, '').split('/')[0]}${args.label ? ' with that label' : ''}.` };
      }
      if (args.action === 'downloads') return { output: await describeDownloads(ctx.stateDir, ctx.sessionId) };
      if (args.action === 'open') webAddress(args.url);
      const page = args.action === 'open' && args.new_tab ? await openNewComputerPage(ctx.stateDir, args.tab) : args.action === 'open' || args.action === 'open_email_link' || args.action === 'email_connect' || args.action === 'oauth_connect' ? await openComputerPage(ctx.stateDir, args.tab) : await computerPage(ctx.stateDir, args.tab);
      // A tab this chat's page opened after the last call ended (a window that opens a moment late) is in front now. What the agent
      // is about to do was meant for the page before it, so it is told, and shown the new page, instead of acting on the wrong one.
      const late = arrivedPages(ctx.stateDir, args.tab).includes(page) ? `A new tab opened after the last action and is now the page in front: ${displayUrl(page.url())} (tabs lists this chat's tabs; switch goes back to another).` : undefined;
      if (late && !AFTER_NEW_TAB.has(args.action)) {
        const view = await observeComputerPage(page, false).catch(quiet('agent/tools/computer-web'));
        return { output: `${late}\nThe ${args.action} was not done: it was meant for the page before. This is the page now.${view ? `\n\n${view.output}` : ''}` };
      }
      bindDownloads(page, ctx.stateDir, ctx.sessionId);
      // A box the page raised and nobody answered holds the whole page: say so before anything touches it.
      bindDialogs(page, DIALOG_AWARE.has(args.action));
      const waiting = pendingDialogNote(page);
      if (waiting && args.action !== 'dialog' && args.action !== 'open') return { output: waiting };
      const leftBehind = args.action === 'open' ? await settleWaitingDialog(page, true) : undefined;
      // A stop returns at once. The work sees the same signal and ends at its next step or wait (Playwright cannot be interrupted
      // mid-call); until it has, the chat's next call waits (bounded), so it never runs while this one still drives the tab.
      let onAbort = (): void => undefined;
      const stopped = new Promise<never>((_resolve, reject) => { onAbort = () => reject(new StoppedError()); });
      stopped.catch(quiet('agent/tools/computer-web'));
      ctx.signal?.addEventListener('abort', onAbort, { once: true });
      let work: Promise<ToolRunResult> | undefined;
      try {
        throwIfStopped(ctx.signal);
        // When the page was last acted on (the click on "Send code"): read_sms_code takes only texts sent after it.
        if (ACTS_ON_PAGE.has(args.action)) pageActedAt.set(page, Date.now());
        work = args.action === 'fill' ? fillWhole(page, args, ctx) : act(page, args, ctx);
        const done = await Promise.race([stopped, work]);
        // The page the batch ended on, which is not `page` when a popup took over.
        const ended = await computerPage(ctx.stateDir, args.tab).catch(() => page);
        const withPicture = !done.isError && args.with_screenshot && ctx.acceptsImages === true && args.action !== 'screenshot' && !ended.isClosed() ? await withScreenshot(done, ended) : done;
        const shown = withPicture.isError ? withPicture : await withSignInHints(withPicture, ended, ctx.stateDir);
        const noted = withDialogNotices(shown, page);
        const lead = [late, leftBehind].filter(Boolean).join('\n\n');
        return lead ? { ...noted, output: `${lead}\n\n${noted.output}` } : noted;
      } finally {
        ctx.signal?.removeEventListener('abort', onAbort);
        if (work && ctx.signal?.aborted) hold(work);
        bindDialogs(page, true);
      }
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
  });
}


// ── What an agent is given ───────────────────────────────────────────────────
// Two tools, each with one job and only its own actions and parameters, made from the table in computer/actions.ts. The long rules that used to
// open the one big description are still here, one call away: help with topic "guide".

const GUIDE: Record<ToolKind, string> = {
  browser: [WEB_TEXT[2], WEB_TEXT[5]].join('\n\n'),
  account: [WEB_TEXT[3], WEB_TEXT[4], WEB_TEXT[6]].join('\n\n'),
};

const HELP_LINE = '{"action":"help"} lists every action with an example; {"action":"help","topic":"<action>"} gives one in full; topic "guide" has the longer rules.';
const DESCRIPTION: Record<ToolKind, string> = {
  browser: [
    "Drive ClikCode's own Chrome (its own saved profile; it starts by itself, and each chat has its own tab). Begin with open: it returns the page with a [ref=eN] on every element. Pass a ref (or the control's visible text) as target to act on it. After an action you get only what changed; observe shows the whole page again. A new tab or popup the page opens is followed automatically.",
    `${listing('browser')}.`,
    'fill with no text fills what only the user knows (name, email, phone, a password) from their saved profile or login, or asks them privately: you are never shown it. Signing in, signing up, API keys and emailed codes are account_use. For a CAPTCHA, or anything only the user can do, use handoff. The browser runs out of sight: when the user wants to watch, use show.',
    `Work through the whole task without checking in at each step; ask only when genuinely blocked. ${HELP_LINE}`,
  ].join('\n'),
  account: [
    'Sign in, create accounts, get API keys and read emailed codes, in the same Chrome tab as browser_use: use browser_use to open pages and click and fill, and this for the parts that handle secrets. You are never shown a password, code or key: ClikCode keeps them and types them in.',
    `${listing('account')}.`,
    'A sign-up: open the page with browser_use. If it offers Continue with Google (and the browser is signed in to Google) use that, else GitHub; only then fill the form with no text: the profile email fills it, and every password box gets a strong password made up for the site and saved. A code by email: read_email_code. Then open the key page and capture_secret with target = the final Create button and a send_to plan. Never click Regenerate just to see a key.',
    `Work through the whole task without checking in at each step; ask real choices (project, account, role) once, up front, and after that only when genuinely blocked. ${HELP_LINE}`,
  ].join('\n'),
};

type Spec = { description?: string } & Record<string, unknown>;
const FULL = WEB_PARAMETERS as unknown as { properties: Record<string, Spec> };

/** The few parameters both tools read, worded for each. */
const SHARED_TEXT: Record<ToolKind, Record<string, string>> = {
  browser: {
    action: 'What to do. help lists every action with an example.',
    target: 'A [ref=…] from the page (e5, or f1e2 inside a frame) or the visible text of the control. For hover, drag, scroll, screenshot, evaluate and wait: the element to use.',
    text: 'fill, choose: the text or option. Leave it out for what only the user knows. wait: the words. upload: a file detail (logo_file) or an absolute path. switch: words of a tab\'s title or address. dialog: a prompt\'s answer.',
    seconds: 'wait, network: the most to wait or record (default 30, up to 120).',
    steps: 'steps, network: what to do, in order, e.g. [{do:"fill", target:"e4", text:"My key"}, {do:"click", target:"e9"}]. do is click, fill, choose, press, scroll, wait, upload, hover or drag; the rest of a step is that action\'s own arguments.',
  },
  account: {
    action: 'What to do. help lists every action with an example.',
    target: 'capture_secret: the final Create button ([ref=…] or its visible text). Or "backup codes" / "qr code" (two-factor set-up). oauth_connect: the connector id (slack, github). auth_code: the field the code goes in. secrets, accounts: words to filter by (accounts with method: the site\'s address).',
    seconds: 'read_email_code, open_email_link: how long to wait for the email to arrive (default 90).',
    steps: 'recipe save: the steps that worked, e.g. [{do:"click", target:"Create key"}]. Never typed values.',
  },
};

/** A long description cut at the end of a sentence: the whole text is still what `help` shows for the action. */
function shorten(text: string, max = 400): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('; '));
  return end > 80 ? head.slice(0, end + 1) : `${head.trimEnd()}…`;
}

/** Parameters whose inner shape is explained by `help` for the action and checked when the action runs: carrying their full nested type
 * definitions in every conversation cost more than the whole rest of the tool. */
const LOOSE = new Set(['steps', 'ask_fields', 'send_to', 'task', 'custom']);
const loosen = (spec: Spec, description: string | undefined): Spec => {
  const type = spec['type'];
  const kinds = Array.isArray(type) ? type : [type];
  return {
    type,
    ...(description !== undefined ? { description } : {}),
    ...(kinds.includes('array') ? { items: { type: 'object', additionalProperties: true } } : {}),
    ...(kinds.includes('object') ? { additionalProperties: true } : {}),
  };
};

function parametersFor(kind: ToolKind): Record<string, unknown> {
  const keep = paramsOf(kind);
  const properties: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(FULL.properties)) {
    if (!keep.has(name)) continue;
    const description = SHARED_TEXT[kind][name] ?? (typeof spec.description === 'string' ? shorten(spec.description) : undefined);
    properties[name] = LOOSE.has(name) ? loosen(spec, description) : description === undefined ? spec : { ...spec, description };
  }
  properties['topic'] = { type: 'string', description: 'help: an action name for its full usage, or "guide" for the longer rules.' };
  // Open on purpose: a chat keeps the argument list it started with, and the reloaded code (hot-tools.ts) understands more.
  return { type: 'object', additionalProperties: true, required: ['action'], properties };
}

/** `help`: every action in a line, or one in full, or the longer rules. */
export function helpFor(kind: ToolKind, topic: string | undefined): string {
  const describe = (name: string): string | undefined => SHARED_TEXT[kind][name] ?? (typeof FULL.properties[name]?.description === 'string' ? FULL.properties[name]!.description : undefined);
  const wanted = topic?.trim();
  if (!wanted) return overview(kind, 'help with topic "guide" gives the longer rules.');
  if (wanted === 'guide') return GUIDE[kind];
  const spec = specOf(wanted);
  if (!spec) return `No action or topic "${wanted}". ${listing(kind)}.`;
  return spec.kind === kind ? usage(spec, describe) : elsewhere(kind, wanted)!;
}

function webTool(kind: ToolKind) {
  return defineTool<WebArgs>({
    name: toolNameOf(kind), class: 'exec',
    description: DESCRIPTION[kind],
    parameters: parametersFor(kind),
    label: computerWebTool.label, paths: computerWebTool.paths, describe: computerWebTool.describe,
    run: async (args, ctx) => {
      const action = String(args.action);
      if (action === 'help') return { output: helpFor(kind, args.topic) };
      const wrong = elsewhere(kind, action);
      if (wrong) return { output: wrong, isError: true };
      if (!specOf(action)) return { output: `Unknown action "${action}" for ${toolNameOf(kind)}. ${listing(kind)}. help lists them with examples.`, isError: true };
      return computerWebTool.run(args, ctx);
    },
  });
}

/** What agents see: the browser, and the part of it that handles accounts and secrets. */
export const browserUseTool = webTool('browser');
export const accountUseTool = webTool('account');

/** The steps of a call, read once and the same way everywhere (the permission prompt, the label, the run): a model may send them as a
 * JSON string. Undefined when they are not a list. */
export function stepList(args: Pick<WebArgs, 'steps'>): Step[] | undefined {
  let value: unknown = args.steps;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return undefined; } }
  return Array.isArray(value) ? value as Step[] : undefined;
}

/** The files an upload names by path, so the permission system can show them and apply its path rules. */
function uploadPaths(args: WebArgs): string[] {
  const steps = stepList(args) ?? [];
  const named = [args.action === 'upload' ? args.text : undefined, ...steps.map(step => step?.do === 'upload' ? step.text : undefined)];
  return named.filter((text): text is string => typeof text === 'string' && path.isAbsolute(text));
}

/** How long a stopped call may keep the chat's queue while its work winds down (a Playwright call in flight cannot be cancelled). */
export const STOP_GRACE_MS = 15_000;

const queues = sharedState('computer-web-queue', () => new Map<string, Promise<unknown>>());
/** Runs `job` after the calls queued before it under `key`. `hold(work)` keeps the queue until `work` settles (at most `ms`) even after
 * the job has answered: a stopped call answers at once, and the next call must not drive the tab while the stopped work still does. */
export function inOrder<T>(key: string, job: (hold: (work: Promise<unknown>, ms?: number) => void) => Promise<T>, graceMs = STOP_GRACE_MS): Promise<T> {
  const holds: Array<Promise<unknown>> = [];
  const hold = (work: Promise<unknown>, ms = graceMs): void => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    holds.push(Promise.race([work.catch(quiet('agent/tools/computer-web')), new Promise(resolve => { timer = setTimeout(resolve, ms); })]).finally(() => clearTimeout(timer)));
  };
  const start = (): Promise<T> => job(hold);
  const run = (queues.get(key) ?? Promise.resolve()).then(start, start);
  const tail = run.catch(quiet('agent/tools/computer-web')).then(() => Promise.all(holds));
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}

/** Whose email a read_email_code / open_email_link may take: unless the sender is named, it must belong to the page's site, with a
 * subject too -- a subject alone ("verification") fits every vendor's mail, and the message is consumed, so parallel sign-ups
 * took each other's codes. A page that is no site (about:blank) adds nothing. */
export function emailSiteScope(args: { from?: string }, pageUrl: string): { site?: string } {
  if (args.from) return {};
  try { return /^https?:$/.test(new URL(pageUrl).protocol) && new URL(pageUrl).hostname.includes('.') ? { site: pageUrl } : {}; } catch { return {}; }
}

/** Actions that can make a page send a code (a click, a key, a form), and when each page last had one. */
const ACTS_ON_PAGE: ReadonlySet<string> = new Set(['click', 'press', 'fill', 'choose', 'steps', 'upload', 'drag', 'open', 'reload', 'login', 'evaluate']);
const pageActedAt = sharedState('page-acted-at', () => new WeakMap<Page, number>());

const handoffs = sharedState('handoffs', () => new Map<string, { link: Promise<string>; url?: string; done: Promise<{ ok: true } | { ok: false; message: string }>; stop: AbortController }>());

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
      try { if ((await fs.stat(value)).isFile()) return value; } catch { /* fail-open-ok: reported below */ }
      throw new Error(`The file saved as ${name} is not on this computer: ${path.basename(value)}.`);
    }
  }
  throw new Error(`The profile has no ${name}. The user can add it with: clikcode computer profile --custom ${name}=/path/to/file`);
}

/** What one step did. `halt` means the steps after it must not run: they were written for a page that is not there yet. */
type StepOutcome = string | { note: string; halt: true };

/** Long jobs (an API being enabled, a resource being created) finish on their own: wait for words to
 * appear (or go) instead of looking again and again. Gives up with the page as it is, and says so. */
async function waitOn(page: Page, step: Step, signal?: AbortSignal): Promise<StepOutcome> {
  if (step.until && step.until !== 'text' || (!step.text?.trim() && (step.selector || step.url !== undefined))) {
    const done = await waitForState(page, step, { locate, displayUrl, signal });
    return done.halt ? { note: done.note, halt: true } : done.note;
  }
  const seconds = Math.min(Math.max(Math.floor(step.seconds ?? 30), 1), 120);
  const text = step.text?.trim();
  // A stop ends the wait at once: it holds the chat's call queue for up to two minutes.
  const pause = (ms: number): Promise<void> => sleep(ms, signal, () => new StoppedError());
  if (!text) { await pause(seconds * 1000); return `Waited ${seconds}s.`; }
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    throwIfStopped(signal);
    const shown = (await page.ariaSnapshot({ mode: 'ai', timeout: 8_000 } as never).catch(() => '') as string).toLowerCase().includes(text.toLowerCase());
    if (shown !== (step.gone === true)) return `${step.gone ? 'Gone' : 'Appeared'}: "${text}".`;
    await pause(1_000);
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
      // A greyed-out button takes the fallback click without doing anything, and "Clicked" would be a lie.
      if (target && await target.isDisabled({ timeout: 1_500 }).catch(() => false)) throw new Error(`${step.target} is disabled: the page will not take the click yet. Look for a field it still needs (one marked invalid or required), fill it, and try again.`);
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
      if (!step.text) throw new Error('Choose needs the option text.');
      return chooseOption(page, await locate(page, step.target), step.text, control => clickOrHint(control));
    }
    case 'press':
      await page.keyboard.press(checkKey(step.key));
      return `Pressed ${step.key}.`;
    case 'scroll': return scrollStep(page, step.target?.trim() ? await locate(page, step.target) : undefined, step);
    case 'wait': return waitOn(page, step, ctx?.signal);
    default: throw new Error(`Unknown step "${String((step as { do?: unknown }).do)}".`);
  }
}

/** What a form field is, for matching it to a saved profile and for the private prompt. */
async function describeField(target: Locator): Promise<{ label: string; password: boolean; hint: FieldHint; placeholder: string; current: string; maxlength: number; readOnly: boolean; required: boolean }> {
  return target.evaluate(element => {
    const el = element as unknown as { type?: string; required?: boolean; value?: string; readOnly?: boolean; disabled?: boolean; labels?: ArrayLike<{ textContent: string | null }>; getAttribute(name: string): string | null };
    const doc = (globalThis as unknown as { document: { getElementById(id: string): { textContent?: string | null } | null } }).document;
    const labelled = el.getAttribute('aria-labelledby')?.split(/\s+/).map(id => doc.getElementById(id)?.textContent?.trim()).filter(Boolean).join(' ');
    const label = (labelled || el.getAttribute('aria-label') || el.labels?.[0]?.textContent || el.getAttribute('placeholder') || el.getAttribute('name') || '').trim();
    const type = el.type ?? 'text';
    return { label, password: type === 'password', placeholder: el.getAttribute('placeholder') ?? '', current: type === 'password' ? '' : el.value ?? '', maxlength: Number(el.getAttribute('maxlength')) || 0,
      required: el.required === true || el.getAttribute('aria-required') === 'true',
      readOnly: el.readOnly === true || el.disabled === true || el.getAttribute('aria-readonly') === 'true',
      hint: { autocomplete: el.getAttribute('autocomplete') ?? '', type, label, text: `${label} ${el.getAttribute('name') ?? ''} ${el.getAttribute('id') ?? ''}` } };
  }).catch(() => ({ label: '', password: false, hint: { autocomplete: '', type: 'text', text: '' }, placeholder: '', current: '', maxlength: 0, readOnly: false, required: false }));
}

/** What a fill says about a box it left empty because the profile has no such detail. A required box stops the worker at once. */
export function requiredNoValue(field: { label: string; step: { target?: unknown }; required: boolean }): string {
  const name = field.label || String(field.step.target ?? 'a field');
  return field.required ? `required, no profile value: ${name}` : `${name} left empty: the profile has no such detail.`;
}

/** Fields that type themselves as they are entered (06/18/1998, (719) 744-3850). */
const PROFILE_FORMATS: Readonly<Record<string, string>> = { phone: 'phone', birthday: 'date' };

/** The frame a step's target lives in (a ref like f2e12 is inside a frame), or the page itself. */
async function frameOf(page: Page, target: string | undefined): Promise<Page | Frame> {
  if (!target) return page;
  try {
    const handle = await (await locate(page, target)).elementHandle({ timeout: 2_000 });
    const frame = await handle?.ownerFrame();
    await handle?.dispose();
    return frame && frame !== page.mainFrame() ? frame : page;
  } catch { return page; }
}

export { VOIP_REFUSED } from '../computer/phone-walls.js';

/** The phone to type here: the profile's (the sign-up number), or the user's own mobile once the page has refused a VoIP number. */
/** Words a page uses to refuse a number from this country (a US number) or to ask for another country's. */
export const COUNTRY_REFUSED = /\b(?:(?:u\.?s\.?|united states|american|north american) (?:phone |mobile )?numbers? (?:are |is )?not (?:supported|accepted|allowed)|(?:this )?country (?:is )?not (?:supported|available)|not available in your (?:country|region)|(?:only|must be an?) (?:uk|united kingdom|canadian|canada|eu|european)\b|(?:uk|canadian|eu) (?:mobile |phone )?numbers? only)\b/i;

/** A number of the profile's for another country: phone_ca is `{ country: 'ca', number }`. */
export interface AbroadPhone { country: string; number: string }

/** The phone to type here: the profile's (the sign-up number); the user's own mobile once the page refuses a VoIP number; once it
 * refuses a US number, the profile's number for the country it asks for (phone_gb for "UK numbers only"), or any other country's
 * when it names none. A page that asks for a country the profile has no number for is a wall: that is thrown, not papered over
 * with another country's number the page will refuse too. */
export async function phoneForPage(page: { evaluate<T>(fn: () => T): Promise<T> }, profilePhone: string, personal: string | undefined, abroad: readonly AbroadPhone[] = []): Promise<string> {
  if (!personal && !abroad.length) return profilePhone;
  const text = await page.evaluate(() => (globalThis as unknown as { document: { body?: { innerText?: string } } }).document.body?.innerText ?? '').catch(() => '');
  if (personal && VOIP_REFUSED.test(text)) return personal;
  if (abroad.length && COUNTRY_REFUSED.test(text)) {
    const asked = askedCountries(text);
    if (!asked) return abroad[0]!.number;
    const fit = abroad.find(phone => asked.includes(phone.country));
    if (fit) return fit.number;
    throw new Error(`The page asks for a phone number from ${asked.slice(0, 2).join('/').toUpperCase()}${asked.length > 2 ? ' (or another EU country)' : ''}; the profile has numbers only for ${abroad.map(phone => phone.country.toUpperCase()).join(', ')}. A person must give one (profile field phone_${asked[0]}).`);
  }
  return profilePhone;
}
const PROFILE_PROMPT: readonly [string, string, boolean][] = [['given_name', 'First name', true], ['family_name', 'Last name', true], ['email', 'Email', true], ['phone', 'Phone (with area code)', true], ['address_line1', 'Street address', true], ['address_line2', 'Apartment / suite (optional)', false], ['city', 'City', true], ['state', 'State', true], ['postal_code', 'Zip / postal code', true], ['country', 'Country', true], ['organization', 'Company (optional)', false], ['birthday', 'Date of birth (month/day/year)', false]];

const profileChoice = sharedState('profile-choice', () => new Map<string, string>());

/** Cards the person approved for a site in this process: `<stateDir>|<site host>` to the card and when the approval lapses. */
const cardApprovals = sharedState('card-approvals', () => new Map<string, { cardId: string; until: number }>());
const NO_CARD = 'Do not use a card';
/** Whether the page shows a card-number box, in any frame (a payment provider's hosted fields are one frame per box). */
async function showsCardNumberBox(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    // fail-open-ok: a frame that went away or cannot be read has no card box to speak of.
    if (await frame.locator('input[autocomplete~="cc-number" i], input[name*="cardnumber" i], input[name*="card-number" i], input[name*="card_number" i], input[id*="cardnumber" i], input[id*="card-number" i]').count().catch(() => 0) > 0) return true;
  }
  return false;
}

/**
 * The card a payment form on `host` may be filled from, or the reason it gets none. A card is typed into a page only when the
 * person says so: one private prompt names the site and the card (the picker a wallet shows), and the answer covers the same
 * form's other boxes for CARD_APPROVAL_MS. Never in an unattended run, and never in a chat that cannot ask privately: both
 * leave the boxes empty and say why. Nothing here shows the agent a number or a code.
 */
async function approvedCard(ctx: ToolContext, host: string, prompt: <T>(wait: () => Promise<T>) => Promise<T>, pageText = ''): Promise<{ card: SavedCard } | { refused: string }> {
  const cards = (await listCards(ctx.stateDir)).filter(card => !cardExpired(card));
  if (!cards.length) return { refused: 'no payment card is saved (or the saved ones have expired). The user adds one with: account_use action card, ask: true' };
  // The user's standing rule (clikcode computer cards usage-only): a page that itself says nothing is charged until something is
  // used, and names no recurring charge, gets the first saved card with no prompt. Every such use is written down.
  const { ruleAllowsCard, recordCardUse } = await import('../computer/card-rule.js');
  const rule = await ruleAllowsCard(ctx.stateDir, pageText);
  if (rule.allowed) {
    const card = cards[0]!;
    await recordCardUse(ctx.stateDir, { at: new Date().toISOString(), host, card: describeCard(card), why: rule.why });
    cardApprovals.set(`${ctx.stateDir}|${host}`, { cardId: card.id, until: Date.now() + CARD_APPROVAL_MS });
    return { card };
  }
  if (await unattendedEnabled(ctx.stateDir)) return { refused: `a payment card is used in an unattended run only under the standing rule, and here ${rule.why}` };
  if (!ctx.requestPrivateLogin) return { refused: 'a payment card is used only with the user\'s approval, and this chat cannot ask them privately' };
  const key = `${ctx.stateDir}|${host}`;
  const standing = cardApprovals.get(key);
  const still = standing && standing.until > Date.now() ? cards.find(card => card.id === standing.cardId) : undefined;
  if (still) return { card: still };
  const labels = cards.map(card => `Use ${describeCard(card)}`);
  const answer = await prompt(() => ctx.requestPrivateLogin!(`https://${host}`, [{ index: -1, key: 'card', label: `Type a saved card into ${host}?`, kind: 'choice', required: true, options: [...labels, NO_CARD] }], ctx.signal));
  const card = cards[labels.indexOf(answer?.card ?? '')];
  if (!card) return { refused: 'the user did not approve using a card on this site' };
  cardApprovals.set(key, { cardId: card.id, until: Date.now() + CARD_APPROVAL_MS });
  return { card };
}

const CODE_BOX = /one-time-code|\b(?:otp|verification|security|passcode|confirmation|pin|digit|code|character)\b/i;
/** The boxes of a code typed one character per box: 4 to 8 adjacent text boxes, each with maxlength 1, that call themselves a code. */
export function splitCodeFields<T extends { password: boolean; maxlength: number; label: string; placeholder: string; hint: { autocomplete: string; text: string } }>(fields: readonly T[]): T[] {
  const single = fields.filter(field => !field.password && field.maxlength === 1);
  if (single.length < 4 || single.length > 8) return [];
  return single.some(field => CODE_BOX.test(`${field.hint.autocomplete} ${field.label} ${field.placeholder} ${field.hint.text}`)) ? [...single] : [];
}

/** Fills that name no text: a saved profile covers what it can (name, address, phone), the user is asked
 * once, privately, for the rest, and what they answer is kept in the profile for next time. */
export async function askForFills(page: Page, steps: readonly Step[], ctx: ToolContext, label?: string, report: string[] = [], clock?: FillClock): Promise<Step[]> {
  const blank = steps.filter(step => step.do === 'fill' && step.text === undefined);
  if (!blank.length) return [...steps];
  if (clock) clock.field = String(blank[0]!.target ?? 'a field');
  const prompt = <T>(wait: () => Promise<T>): Promise<T> => clock ? clock.paused(wait) : wait();
  const skipped = new Map<Step, string>();
  const origin = new URL(page.url()).origin;
  const fields = await Promise.all(blank.map(async step => ({ step, ...await describeField(await locate(page, step.target)) })));
  const profiles = await listProfiles(ctx.stateDir);
  let profile = profiles.length === 1 ? profiles[0] : undefined;
  if (profiles.length > 1) {
    // Never ask which profile: choose the one that fits this form best (see bestProfileFor).
    // Decided afresh each time from the call's label, the site and the default: a remembered choice let one earlier fill pin a site to another profile.
    profile = bestProfileFor(profiles, fields.map(field => field.hint), label, new URL(page.url()).hostname);
  }
  if (profile && profiles.length > 1) report.push(`Autofill used the profile "${profile.label}".`);
  const values = new Map<Step, string>();
  const ask: { step: Step; key: FillKey | undefined; field: LoginField }[] = [];
  // A saved login for this site fills its sign-in fields. Not on a form that creates a password (two password
  // boxes): that is a signup, and the saved login belongs to the account that already exists.
  let login: Record<string, string> | undefined;
  let siteHasLogin = false;
  // An autofill of a sign-in form asks, with the saved values shown. Several accounts are a choice, and the chosen one
  // fills the page. One account is shown so its email or password can be changed. A different email is stored as a new
  // account; the same email with a new password replaces that account.
  let confirmSignIn = false;
  // What the page is, by its path, never its host or query: "https://login.twilio.com/u/reset-password/change" matched /\/login\b/ on
  // the host, and /register?return_to=/signin matched "signin" in its query. One rule for both (password-page.ts signInPath).
  const signInAddress = signInPath(page.url());
  if (fields.filter(field => field.password).length <= 1) {
    const everyLogin = await savedLoginsForSite(ctx.stateDir, page.url()).catch(() => []);
    siteHasLogin = everyLogin.length > 0;
    let accounts = everyLogin.filter(account => !account.rejected);
    // An incomplete capture must not hide the saved credential that can finish this password page.
    if (fields.some(field => field.password) && accounts.some(account => account.usable)) accounts = accounts.filter(account => account.usable);
    const accountField = fields.some(field => loginValueFor({ username: 'x', password: 'x' }, field));
    // Google's first page is only the email box. That is still a sign-in, and the email has to be asked.
    const signIn = accountField && (fields.filter(field => field.password).length === 1 || signInAddress);
    if (accounts.length && accountField) {
      let account = accounts.length === 1 ? accounts[0] : accounts.find(candidate => candidate.id === profileChoice.get(`${ctx.stateDir}|login|${origin}`));
      // Several logins and the profile's email names one of them: that is the account, with no question.
      const own = profile?.fields.sso_email ?? profile?.fields.email;
      if (!account && own) account = accounts.find(candidate => candidate.label.split(' · ').some(value => value.toLowerCase() === own.toLowerCase()));
      if (!account && ctx.requestPrivateLogin) {
        const labels = accounts.map(candidate => candidate.label);
        const answer = await prompt(() => ctx.requestPrivateLogin!(origin, [{ index: -1, key: 'account', label: 'Sign in with which account?', kind: 'choice', required: true, options: [...labels, 'Enter a different one'] }], ctx.signal));
        account = accounts[labels.indexOf(answer?.account ?? '')];
        if (account) profileChoice.set(`${ctx.stateDir}|login|${origin}`, account.id);
      }
      if (account) login = await savedLoginFields(ctx.stateDir, page.url(), account.id).catch(quiet('agent/tools/computer-web'));
    }
    // Interactive sign-in retains its edit prompt; unattended sign-in uses the saved credential.
    if (signIn) confirmSignIn = !await unattendedEnabled(ctx.stateDir);
  }
  // A signup form (two password boxes, a new-password box, or a sign-up page): one strong password for the whole form
  // (see below), kept in Secrets Manager with the login, never shown.
  const passwordFields = fields.filter(field => field.password);
  // The password box may sit in a frame (Braintree's activation form): its count, its page's words and its rules are read in that
  // frame. Read from the top page they were absent, so the site's "at least 14 characters" never reached the generator.
  const scope = passwordFields.length ? await frameOf(page, passwordFields[0]!.step.target) : page;
  // A form filled one box per call shows only one password box here, so the page itself is asked how many it has.
  const boxesOnPage = passwordFields.length ? await scope.locator('input[type="password"]:visible').count().catch(() => 0) : 0;
  // A /login page is a sign-in even when the page has a second password box. Treating that as a signup would skip the
  // confirm prompt and fill the profile email with no chance to change it.
  const loginPage = signInAddress;
  // The page's own words decide a page the address and boxes do not (a post-signup "Create your new password"): see classifyPasswordPage.
  const pageContext = passwordFields.length ? await readPasswordPageContext(scope) : undefined;
  const pageKind = pageContext ? classifyPasswordPage({ ...pageContext, url: page.url() }) : undefined;
  const newPasswordPage = pageKind?.kind === 'signup' && await generatedPasswordsAllowed(ctx.stateDir);
  const signingUp = newPasswordPage || !loginPage && (passwordFields.length >= 2 || boxesOnPage >= 2 || passwordFields.some(field => /new-password/i.test(field.hint.autocomplete))
    || (passwordFields.length > 0 && newPasswordPath(page.url())));
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
      policy = await readPasswordPolicy(scope);
      // A reset page refuses the account's current password ("previously used"): it always gets a new one, which holdSignup saves.
      const reset = resetPasswordPage(page.url(), pageContext?.headings);
      generated = (reset ? undefined : await savedPasswordFor(ctx.stateDir, page.url(), email)) ?? generatePassword(policy);
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
  let card: Awaited<ReturnType<typeof approvedCard>> | undefined;
  let usedCard = false;
  let onCardForm: boolean | undefined;
  for (const field of fields) {
    if (values.has(field.step)) continue;
    if (clock) clock.field = field.label || String(field.step.target);
    // A box the page already filled and locked (the account's email on a post-signup page) is left alone: nothing to type, nothing to ask.
    if (field.readOnly) { skipped.set(field.step, `${field.label || field.step.target} is already filled and read-only; left as it is.`); continue; }
    // A payment card box (number, expiry, security code, name on card): filled only from a saved card the person approves for
    // this site, before any password or profile rule sees it (a security-code box is often type=password). Top-level host: a
    // hosted payment field lives in its provider's frame, and the person is asked about the site they are paying.
    onCardForm ??= fields.some(other => cardFieldFor(other.hint) === 'number') || await showsCardNumberBox(page);
    const cardKind = cardFieldFor(field.hint, onCardForm);
    if (cardKind) {
      const name = field.label || String(field.step.target);
      card ??= await approvedCard(ctx, new URL(page.url()).hostname.replace(/^www\./, ''), prompt, await page.locator('body').innerText({ timeout: 5_000 }).catch(() => ''));
      if ('refused' in card) { skipped.set(field.step, `${name} left empty: ${card.refused}.`); continue; }
      const chosen = card.card;
      let code = cardKind === 'code' ? await readCardSecret(ctx.stateDir, chosen, 'code') : undefined;
      if (cardKind === 'code' && !code) {
        // Not kept with the card: asked for now, typed, and forgotten.
        const typed = await prompt(() => ctx.requestPrivateLogin!(`https://${new URL(page.url()).hostname}`, [{ index: -1, key: 'code', label: `Security code for ${describeCard(chosen)}`, kind: 'password', required: true }], ctx.signal));
        code = typed?.code?.replace(/\D+/g, '') || undefined;
      }
      const number = cardKind === 'number' ? await readCardSecret(ctx.stateDir, chosen, 'number') : undefined;
      const value = cardValueFor(cardKind, chosen, { ...(number ? { number } : {}), ...(code ? { code } : {}) }, { placeholder: field.placeholder, maxlength: field.maxlength })
        ?? (cardKind === 'name' ? [profile?.fields.given_name, profile?.fields.family_name].filter(Boolean).join(' ') || undefined : undefined);
      if (!value) { skipped.set(field.step, `${name} left empty: the saved card has no value for it.`); continue; }
      if (cardKind === 'number' || cardKind === 'code') registerSecret(value);
      values.set(field.step, value);
      if (!usedCard) { usedCard = true; report.push(`Filled from the saved card ${describeCard(chosen)}, which the user approved for this site. The number and security code were not shown to you.`); }
      continue;
    }
    if (field.password && generated) { values.set(field.step, generated); continue; }
    const fromLogin = login ? loginValueFor(login, field) : undefined;
    if (fromLogin && !(confirmSignIn && !signingUp)) { values.set(field.step, fromLogin); continue; }
    // A password box on a page that is not a sign-up (confirm your password to verify an email, re-enter it) is for the password this
    // site's account was made with: the one typed into this page's form, else the one saved for this site. The profile's own `password`
    // secret is never what a site with a generated password wants.
    if (field.password && !(confirmSignIn && !signingUp)) {
      const own = await sitePasswordFor(ctx.stateDir, page, email);
      if (own) { registerSecret(own); values.set(field.step, own); continue; }
      // A site that emails the password it made for the account (no password box at signup): read from the mailbox, kept in
      // the vault under the address it came to, and typed without being shown.
      if (!signingUp && page.url().startsWith('https:')) {
        const mailed = await passwordFromMailbox(ctx.stateDir, page.url(), { signal: ctx.signal });
        if (mailed) {
          registerSecret(mailed.password);
          await saveLoginFields(ctx.stateDir, page.url(), { username: email ?? mailed.mailbox, password: mailed.password }).catch(quiet('agent/tools/computer-web'));
          values.set(field.step, mailed.password);
          report.push(`The password for this site came from the email it sent to ${mailed.mailbox}; saved for this site. It was not shown to you.`);
          continue;
        }
      }
    }
    // A secret kept with the profile (never shown to the agent) fills the box it is for: the password, a recovery code.
    const secretKey = secretFieldFor(profile, field.hint);
    const secret = secretKey && profile && !(confirmSignIn && !signingUp && field.password) ? await readProfileSecret(ctx.stateDir, profile, secretKey) : undefined;
    if (secret) { registerSecret(secret); values.set(field.step, secret); continue; }
    // A detail the agent asked for by name ("Support email") is more specific than the standard field its words also suggest.
    const asked = field.password ? undefined : customFieldFor(profile, field.hint);
    if (asked) { values.set(field.step, asked.field.value); continue; }
    // A registration, VAT or tax number: the profile has none. Left empty and reported, never filled with something else.
    if (!field.password && isUnfillable(field.hint)) { skipped.set(field.step, requiredNoValue(field)); continue; }
    // A lone one-time-code box is filled from the emailed code when a mailbox is connected: the right sender, once, no agent call.
    if (!field.password && fields.length === 1 && /one-time-code|\b(?:otp|verification|security code|passcode|confirmation code)\b|\bcode\b/i.test(`${field.hint.autocomplete} ${field.label} ${field.placeholder}`) && !/postal|zip|post.?code/i.test(`${field.label} ${field.placeholder} ${field.hint.text}`)) {
      const code = await codeFromMailbox(ctx.stateDir, page.url(), Date.now() - 120_000, ctx.signal);
      if (code) { registerSecret(code); values.set(field.step, code); continue; }
    }
    const key = field.password ? undefined : profileKeyFor(field.hint);
    const known = key ? profileValue(profile?.fields, key) : undefined;
    if (confirmSignIn && !signingUp && (field.password || fromLogin || key === 'email')) {
      const current = field.password ? fromLogin : (fromLogin ?? known);
      ask.push({ step: field.step, key: undefined, field: { index: ask.length, key: `fill${ask.length}`, label: field.label || String(field.step.target), kind: field.password ? 'password' : 'text', required: true, ...(current ? { current } : {}) } });
      continue;
    }
    // The profile phone is the Twilio number sign-ups use; a site that refuses it as VoIP or virtual gets the user's own mobile
    // (custom field phone_personal), whose texts the Mac reads. Decided by what the page says, so the runner and agents fill the same.
    const abroad = Object.entries(profile?.custom ?? {}).filter(([name, field]) => /^phone_[a-z]{2}$/.test(name) && field.value).map(([name, field]) => ({ country: name.slice(6), number: field.value }));
    const phone = key === 'phone' && known ? await phoneForPage(page, known, profile?.custom?.phone_personal?.value, abroad) : known;
    if (phone) { values.set(field.step, key === 'phone' ? phoneFor(phone, field.placeholder, field.current) : key === 'birthday' ? birthdayFor(phone, `${field.label} ${field.placeholder}`) : phone); continue; }
    ask.push({ step: field.step, key, field: { index: ask.length, key: `fill${ask.length}`, label: field.label || String(field.step.target), kind: field.password ? 'password' : 'text', required: true } });
  }
  if (generated) {
    registerSecret(generated);
    await holdSignup(ctx.stateDir, page, generated, email);
    if (mine) rememberGenerated(page, generated, policy ?? await readPasswordPolicy(scope));
  }
  if (ask.length) {
    // A sign-in password with no saved login for this site and none in the profile cannot be made up: say so and park
    // it (in the queue, with the reason) rather than failing, so the run goes on to the next site.
    const needPassword = ask.filter(item => item.field.kind === 'password').map(item => item.field);
    const noPassword = (): Promise<never> => park(ctx.stateDir, page.url(), needPassword, `${siteHasLogin ? 'the saved password for this site was refused earlier' : 'no saved login for this site'}; treated as a ${signingUp ? 'new-password page' : 'sign-in page'} (${pageKind?.reason ?? 'no password box'}); ${siteHasLogin ? 'enter the current password with the add_login action' : 'sign in once with the login action or add one with `clikcode computer secrets --import`'}`);
    if (!ctx.requestPrivateLogin) { if (needPassword.length) return noPassword(); throw new Error('Fill needs text: this chat cannot ask the user privately.'); }
    const answers = await prompt(() => ctx.requestPrivateLogin!(origin, ask.map(item => item.field), ctx.signal));
    if (!answers) { if (needPassword.length) return noPassword(); throw new Error('The user did not answer the private prompt, so these fields were left empty.'); }
    const learned: Partial<Record<ProfileKey, string>> = {};
    for (const item of ask) {
      const answer = answers[item.field.key] ?? '';
      values.set(item.step, answer);
      // A password typed into a form shows in the page's own text afterwards: hold it back from every view.
      if (item.field.kind === 'password' && answer) { registerSecret(answer); await holdSignup(ctx.stateDir, page, answer, email).catch(quiet('agent/tools/computer-web')); }
      // A whole name typed in one box is not split into given and family guesses: only a box that is one detail teaches it.
      else if (item.key && item.key !== 'name' && answer) learned[item.key] = answer;
    }
    // The email the person just typed is the account's: attach it to the login kept above (it was kept without one).
    const typedEmail = ask.map(item => values.get(item.step)).find(value => value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
    const kept = generated ?? pendingSignupPassword(page);
    if (kept && !email && typedEmail) await holdSignup(ctx.stateDir, page, kept, typedEmail).catch(quiet('agent/tools/computer-web'));
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
  for (const note of skipped.values()) report.push(note);
  return steps.filter(step => !skipped.has(step)).map(step => values.has(step) ? { ...step, text: values.get(step)! } : step);
}

/** An error or alert the page is showing right now (a line that names an error, failure or a needed payment), for a failure report. */
async function pageProblem(page: Page | undefined): Promise<string> {
  if (!page) return '';
  try {
    const text = await page.evaluate(() => (globalThis as unknown as { document: { body: { innerText: string } } }).document.body.innerText);
    const line = text.split('\n').map(item => item.trim()).find(item => item.length > 8 && item.length < 200 && /\b(error|failed|failure|unable|invalid|purchase|insufficient|required|not allowed|denied)\b/i.test(item));
    return line ?? '';
  } catch { return ''; }
}

/** Why a form will not go on: fields the browser or the page marks invalid, and a main button that is disabled. */
async function formProblems(page: Page): Promise<string[]> {
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
export async function runSteps(page: Page, steps: readonly Step[], ctx: ToolContext, tab?: string, profileLabel?: string, guard?: (page: Page) => Promise<string | undefined>, wholeFill?: FillClock): Promise<ToolRunResult> {
  const notes: string[] = [];
  let current = page;
  const blankFirst = steps.find(step => step.do === 'fill' && step.text === undefined);
  try {
    // A single fill is raced as a whole by the caller (fillWhole), whose clock is used here; a batch times only its fill work.
    steps = wholeFill ? await askForFills(page, steps, ctx, profileLabel, notes, wholeFill) : await withFillDeadline(String(blankFirst?.target ?? ''), clock => askForFills(page, steps, ctx, profileLabel, notes, clock));
  } catch (error) {
    if (!(error instanceof FillTimeout)) throw error;
    // The tab stays usable: the page is described again (briefly) so the next call starts from what it shows now.
    const view = hasPendingDialog(current) ? undefined : await withFillDeadline('page', () => observeComputerPage(current, false, false, undefined, true), 8_000).catch(quiet('agent/tools/computer-web'));
    return { output: `${[...notes, error.message].join('\n')}${view ? `\n\n${view.output}` : ''}`, isError: true };
  }
  for (const [index, planned] of steps.entries()) {
    // A stop ends the batch here: the steps after it are not run on a tab the user took back.
    throwIfStopped(ctx.signal);
    // A later fill of the same batch still carries a generated password the site has since refused: it gets the current one.
    const held = generatedFor(current);
    const step = planned.do === 'fill' && held && planned.text && held.past.has(planned.text) ? { ...planned, text: held.password } : planned;
    // A tab the chat's own page opens is the chat's as it opens (browser.ts); what opened before this step was reported with the step before.
    arrivedPages(ctx.stateDir, tab);
    let halted = false;
    try {
      // Steps are journaled for an automatic recipe (see recipe-recorder.ts); a replay is not journaled again.
      const before = guard ? undefined : { url: current.url(), label: await controlName(current, step.target) };
      const done = step.do === 'fill' && !wholeFill ? await withFillDeadline(String(step.target ?? 'a field'), () => doStep(current, step, ctx), Math.max(30_000, 10_000 + (step.text?.length ?? 0) / 5)) : await doStep(current, step, ctx);
      // A step a recipe cannot replay by control text (right-click, a canvas position, a drag) leaves the journal unsaved rather than wrong.
      if (before && typeof done === 'string') {
        const replayable = PLAIN_STEPS.has(step.do) && !(step.do === 'click' && (clickExtras(step) || step.x !== undefined));
        noteStep(journalKey(ctx.stateDir, tab), before.url, replayable ? step as Parameters<typeof noteStep>[2] : { do: 'click' }, replayable ? before.label : undefined);
      }
      if (typeof done === 'string') notes.push(done); else { notes.push(done.note); halted = true; }
      // A sign-in button often fetches before it opens its window: give it a moment to show up.
      if (step.do === 'click' && !arrivedPages(ctx.stateDir, tab, false).length && SIGN_IN_CLICK.test(`${before?.label ?? ''} ${step.target ?? ''}`)) await current.waitForEvent('popup', { timeout: 4_000 }).catch(quiet('agent/tools/computer-web'));
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
      if (error instanceof StoppedError) throw error;
      // The page closing itself (a sign-in popup that finished) is read from the page, not from an error message.
      if (current.isClosed()) {
        // The chat's own tab that is in front now, never just any tab of the shared browser: those are other chats'.
        const live = ownedPages(ctx.stateDir, tab).current;
        if (live) { current = live; adoptPage(ctx.stateDir, current, tab); halted = true; notes.push(`Step ${index + 1} (${step.do}): the tab closed itself, so this is the page that is open now.`); }
      }
      if (!halted) {
        // What changed, not the whole page again: a failed step in a long batch used to repeat thousands of tokens.
        const view = hasPendingDialog(current) ? undefined : await observeComputerPage(current, false, false, undefined, true).catch(quiet('agent/tools/computer-web'));
        return { output: `${[...notes, `Step ${index + 1} (${step.do}${step.target ? ` ${step.target}` : ''}) failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`].join('\n')}${view ? `\n\n${view.output}` : ''}`, isError: true };
      }
    }
    const next = arrivedPages(ctx.stateDir, tab).at(-1);
    if (next) {
      // Google's account chooser in a popup: the account is chosen and consent pressed, and the page that opened it carries on.
      const followed = await followPopup(current, next, { email: await profileEmail(ctx.stateDir), signal: ctx.signal }).catch(quiet('agent/tools/computer-web'));
      if (followed?.note) notes.push(followed.note);
      const landed = followed?.page ?? next;
      // Where the chat is now is the tab in front: the popup, or the page that opened it once a sign-in window has closed.
      current = landed;
      adoptPage(ctx.stateDir, current, tab);
      await settle(current);
      if (!followed?.note) notes.push(`A new tab opened and is now the page: ${displayUrl(current.url())}`);
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
    const email = (await profileEmail(stateDir));
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
      await sleep(1_500 * (attempt + 1));
    }
  }
}

const withMailbox = (view: ToolRunResult, line: string): ToolRunResult => ({ ...view, output: `${line}\n\n${view.output}` });

/** The default mailbox emailed codes and links are read from: the profile's sign-in email when connected, else the first connected one, else the profile email. The same for every tab and chat. */
async function mailboxAddress(stateDir: string): Promise<string | undefined> {
  return (await emailStatus(stateDir)).email || await profileEmail(stateDir);
}

const mailboxLabel = async (stateDir: string, account?: number): Promise<string> => account === undefined ? await mailboxAddress(stateDir) ?? 'Gmail account /u/0' : `Gmail account /u/${account}`;

/** The addresses that say which mailbox a page's email goes to, best first: the one typed into the page's email box, then the saved logins of the site. */
async function mailboxHints(stateDir: string, page: Page): Promise<string[]> {
  const typed = await page.locator('input[type=email], input[name*=email i], input[id*=email i], input[autocomplete=username], input[autocomplete=email]').evaluateAll(nodes => nodes.map(n => (n as unknown as { value?: string }).value ?? '').filter(v => /^[^\s@]+@[^\s@]+$/.test(v.trim()))).catch(() => [] as string[]);
  return [...typed.map(v => v.trim()), ...await loginAddresses(stateDir, page.url())];
}

/** The newest message matching from/subject in the signed-in Gmail, opened; its body. Waits for one that has just been sent. */
async function openLatestEmail(page: Page, args: WebArgs, stateDir: string): Promise<Locator> {
  if (!args.from && !args.subject) throw new Error(`${args.action} needs from or subject.`);
  // The mailbox is the profile's sign-in account (every sign-up used it), not whichever Gmail happens to be first.
  const mailbox = args.account ?? await mailboxAddress(stateDir) ?? 0;
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

/** A single fill, raced as a whole: reading the fields, the vault and generate-password paths, typing, and settling all count. When the
 * time is up the work is abandoned (Playwright cannot cancel a pending call), the tab is recovered and the page described afresh. */
export async function fillWhole(page: Page, args: WebArgs, ctx: ToolContext, run: (clock: FillClock) => Promise<ToolRunResult> = clock => act(page, args, ctx, clock), ms = Math.max(FILL_DEADLINE_MS, 10_000 + (args.text?.length ?? 0) / 5)): Promise<ToolRunResult> {
  try { return await withFillDeadline(String(args.target ?? 'a field'), run, ms); }
  catch (error) {
    if (!(error instanceof FillTimeout)) throw error;
    const fresh = await recoverComputerPage(ctx.stateDir, page, args.tab).catch(() => page);
    const view = hasPendingDialog(fresh) ? undefined : await withFillDeadline('page', () => observeComputerPage(fresh, false, false, undefined, true), 8_000).catch(quiet('agent/tools/computer-web'));
    return { output: `${error.message}${view ? `\n\n${view.output}` : ''}`, isError: true };
  }
}

async function act(page: Page, args: WebArgs, ctx: ToolContext, clock?: FillClock): Promise<ToolRunResult> {
  if ((PAGE_ACTIONS as readonly string[]).includes(args.action)) return pageAction(page, args, { stateDir: ctx.stateDir, ...(args.tab ? { tab: args.tab } : {}), acceptsImages: ctx.acceptsImages === true, locate, settle, displayUrl, view: (shown, compact) => observeComputerPage(shown, ctx.acceptsImages === true, false, undefined, compact === true) });
  if (INTERACTIONS.has(args.action)) {
    const one: Step = { do: args.action as Step['do'], ...stepExtras(args), ...(args.at ? { at: args.at } : {}), ...(args.target ? { target: args.target } : {}), ...(args.text !== undefined ? { text: args.text } : {}), ...(args.key ? { key: args.key } : {}), ...(args.direction ? { direction: args.direction } : {}), ...(args.accept_dialog ? { accept_dialog: true } : {}), ...(args.gone ? { gone: true } : {}), ...(args.seconds ? { seconds: args.seconds } : {}) };
    return runSteps(page, [one], ctx, args.tab, args.label, undefined, clock);
  }
  switch (args.action) {
    case 'open': {
      await denyPermissionsFor(page, webAddress(args.url));
      const authNote = args.http_auth ? await applyHttpAuth(page, webAddress(args.url), args, ctx) : undefined;
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
      const withAuth = authNote ? { ...withNotes, output: `${authNote}\n\n${withNotes.output}` } : withNotes;
      return recipes ? { ...withAuth, output: `${recipes}\n\n${withAuth.output}` } : withAuth;
    }
    case 'viewport': return { output: await runViewport(page, args) };
    case 'pdf': return { output: await runPdf(page, args, ctx) };
    case 'cookies': return { output: await runCookies(page, args) };
    case 'permissions': return { output: await runPermissions(page, args) };
    case 'auth': {
      if (args.clear) return { output: await clearHttpAuth(page) };
      // Sign-in for the named site (or the open page's), then the page is loaded again with it.
      if (args.url) return act(page, { ...args, action: 'open', http_auth: args.http_auth || args.label || true }, ctx);
      const note = await applyHttpAuth(page, page.url(), args, ctx);
      await withNetworkRetry(() => page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }));
      await settle(page);
      return { output: `${note}\n\n${(await observeComputerPage(page, false)).output}` };
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
      const mine = (await profileEmail(ctx.stateDir));
      const filled = { ...recipe, steps: recipe.steps.map(step => ({ ...step, ...(step.target ? { target: fillPlaceholders(step.target, { sso_email: mine }) } : {}), ...(step.text ? { text: fillPlaceholders(step.text, { sso_email: mine }) } : {}) })) };
      const replay = await replayRecipe(filled, (steps, guard) => runSteps(page, steps as Step[], ctx, args.tab, args.label, async current => { ended = current; return guard(); }), async () => scrubSecrets(await ended.ariaSnapshot({ mode: 'ai', timeout: 8_000 } as never) as string),
        async () => (await passHumanCheck(ended, { stateDir: ctx.stateDir, solve: !tabIsInCloud(ctx.stateDir, args.tab) && await captchaSolvingAllowed(ctx.stateDir), ...(ctx.signal ? { signal: ctx.signal } : {}) })).outcome === 'cleared',
        () => ended.url());
      if (replay.completed) await saveRecipe(ctx.stateDir, { host: recipe.host, loginRoute: recipe.loginRoute, steps: recipe.steps.filter(step => !destructiveStep(step)), ...(recipe.keyPage ? { keyPage: recipe.keyPage } : {}), ...(recipe.captureHint ? { captureHint: recipe.captureHint } : {}) }).catch(quiet('agent/tools/computer-web'));
      return { output: replay.output, ...(replay.isError ? { isError: true } : {}) };
    }
    case 'dialog': {
      const said = await answerDialog(page, args.accept_dialog === true, args.text);
      await page.waitForTimeout(300);
      const next = pendingDialogNote(page);
      if (next) return { output: `${said}\n\n${next}` };
      return { output: `${said}\n\n${(await observeComputerPage(page, false, false, undefined, true)).output}` };
    }
    case 'read_value': {
      const label = (args.label ?? args.target ?? '').trim();
      if (!label) throw new Error('read_value needs label: the text the page shows beside the value, e.g. "Application ID".');
      const chosen = chooseValue(label, await labelledCandidates(page, label));
      if (chosen.kind === 'refused') return { output: `Not read: ${chosen.reason}.`, isError: true };
      // A short plain value is returned. An opaque id (it looks like a token to every filter) or any value with secret_name goes to the vault and comes back as a reference for send_to values.
      if (chosen.kind === 'value' && !args.secret_name && !/key|secret|token|password|api/i.test(label) && scrubSecrets(chosen.value) === chosen.value) return { output: `${label}: ${chosen.value}${chosen.alternatives ? ` (${chosen.alternatives} other candidate${chosen.alternatives === 1 ? '' : 's'} on the page; use a more exact label if this is not it)` : ''}\nTo send it on: send_to values {"name":"${chosen.value}"}.` };
      const origin = new URL(page.url()).origin;
      const name = args.secret_name?.trim() || `${new URL(page.url()).hostname.replace(/^www\./, '')}/${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
      await saveNamedSecret(ctx.stateDir, name, chosen.value, { url: origin, page: (() => { const u = new URL(page.url()); return `${u.origin}${u.pathname}`; })(), vendor: args.vendor ?? new URL(page.url()).hostname.replace(/^www\./, ''), owner: args.owner ?? await profileEmail(ctx.stateDir) });
      return { output: `${label}: read (${chosen.value.length} characters) and saved as "${name}"; it is not shown. Pass it on with send_to values {"<name>":"secret:${name}"}, e.g. {"to":"clikdeploy-connection","with":{"integration":"..."},"values":{"app_id":"secret:${name}"}}.` };
    }
    case 'observe': {
      if (args.why_blank) { const why = await whyBlank(page, { seconds: args.seconds }); return { output: `${why}\n\n${(await observeComputerPage(page, ctx.acceptsImages === true)).output}` }; }
      requestDocumentPages(page, args.pages); return observeComputerPage(page, ctx.acceptsImages === true, args.full === true, args.find);
    }
    case 'steps':
      const list = stepList(args);
      if (!Array.isArray(list) || !list.length) throw new Error('steps needs a list, e.g. [{"do":"click","target":"e5"}].');
      return runSteps(page, list, ctx, args.tab, args.label);
    case 'network': {
      // Does the steps (or just waits and reloads nothing) while recording the page's API calls: the vendor's own web app
      // shows the real endpoint, method and answer shape when documentation is thin. Header values are never shown.
      const list = stepList(args);
      const { recordNetwork, describeCalls } = await import('../computer/network-capture.js');
      const { result, calls, dropped } = await recordNetwork(page, async () => Array.isArray(list) && list.length ? runSteps(page, list, ctx, args.tab, args.label) : (await sleep((args.seconds ?? 5) * 1000, ctx.signal, () => new StoppedError()), undefined), { ...(args.find ? { find: args.find } : {}), ...(args.bodies ? { bodies: true } : {}) });
      return { output: `${result?.output ? `${result.output}\n\n` : ''}${describeCalls(calls, dropped)}`, ...(result?.isError ? { isError: true } : {}) };
    }
    case 'open_email_link': {
      if (await emailConnected(ctx.stateDir)) {
        const mail = await findEmail(ctx.stateDir, { address: args.address, hints: await mailboxHints(ctx.stateDir, page), from: args.from, subject: args.subject, ...emailSiteScope(args, page.url()), spam: true, consume: true, accept: args.from || args.subject ? (m => m.links.length > 0) : looksLikeLinkEmail, timeoutMs: (args.seconds ?? 90) * 1000, signal: ctx.signal });
        const anchors = mail.anchors?.length ? mail.anchors : mail.links.map(href => ({ href, text: '' }));
        const pick = pickLink(anchors, args.link);
        if (!pick) throw new Error(`The email has no ${args.link ? `link mentioning "${args.link}"` : 'usable link'}. Links found: ${anchors.slice(0, 6).map(link => link.text.trim() || displayUrl(link.href)).join(', ') || 'none'}.`);
        // A tracking link hops through redirects, and a hop can drop the first request (net::ERR_NETWORK_CHANGED, ERR_ABORTED) while
        // the page still arrives. The email is already used up, so the outcome is read from where the tab ended, not from that error;
        // and the link itself (a one-time sign-in) is never put in the message.
        const before = page.url();
        const failed = await page.goto(pick.chosen.href, { waitUntil: 'domcontentloaded', timeout: 30_000 }).then(() => undefined, (error: unknown) => String(error instanceof Error ? error.message : error).split('\n')[0]!);
        if (failed) {
          await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(quiet('agent/tools/computer-web'));
          const moved = page.url() !== before && !page.url().startsWith('chrome-error:') && page.url() !== 'about:blank';
          if (!moved) {
            const again = await page.goto(pick.chosen.href, { waitUntil: 'domcontentloaded', timeout: 30_000 }).then(() => undefined, () => 'failed');
            if (again) throw new Error(`The link from the email in ${mail.mailbox} did not open (${failed.replace(/https?:\/\/\S+/g, 'the link').slice(0, 120)}). The email was used; ask the site to send it again.`);
          }
        }
        await settle(page);
        return withMailbox(await observeComputerPage(page, ctx.acceptsImages === true), chosenNote(pick, `Opened the link from the email in ${mail.mailbox}.`));
      }
      const body = await openLatestEmail(page, args, ctx.stateDir);
      const links = await body.locator('a[href]').evaluateAll(nodes => nodes.map(node => {
        const el = node as unknown as { href: string; textContent: string | null; className?: string; getAttribute(n: string): string | null; querySelector(s: string): unknown };
        const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        return { href: el.href, text: text || (el.querySelector('img') as { alt?: string } | null)?.alt || '', button: /button|btn/i.test(`${el.className ?? ''} ${el.getAttribute('role') ?? ''}`) || /padding|border-radius|background/i.test(el.getAttribute('style') ?? ''), image: !text && !!el.querySelector('img') };
      }));
      const real = links.map(link => { try { const u = new URL(link.href); return { ...link, href: u.hostname.endsWith('google.com') && u.pathname === '/url' ? u.searchParams.get('q') ?? link.href : link.href }; } catch { return link; } })
        .filter(link => /^https:/.test(link.href));
      const pick = pickLink(real, args.link);
      if (!pick) throw new Error(`The email has no ${args.link ? `link mentioning "${args.link}"` : 'usable link'}. Links found: ${real.slice(0, 6).map(link => link.text || displayUrl(link.href)).join(', ') || 'none'}.`);
      await page.goto(pick.chosen.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await settle(page);
      return withMailbox(await observeComputerPage(page, ctx.acceptsImages === true), chosenNote(pick, `Opened the link from the email in ${await mailboxLabel(ctx.stateDir, args.account)}.`));
    }
    case 'email_connect': {
      // One consent in this browser stores the mailbox in Secrets Manager; read_email_code and open_email_link then use the Gmail API.
      const email = args.address?.trim() || (await profileEmail(ctx.stateDir));
      const done = await connectEmail(ctx.stateDir, page, { email, progress: line => line && ctx.emitOutput?.(line) });
      return { output: `Mailbox connected${done.email ? `: ${done.email}` : ''}. Connected mailboxes: ${(await emailStatus(ctx.stateDir)).mailboxes.map(m => m.email).join(', ')}. read_email_code and open_email_link now read mail directly and wait for it to arrive.` };
    }
    case 'oauth_connect': {
      const email = (await profileEmail(ctx.stateDir));
      const values = oauthValues(args.values);
      const done = await oauthConnect(args.target?.trim() ?? '', page, { email, stateDir: ctx.stateDir, signal: ctx.signal, ...(values ? { values } : {}), progress: line => line && ctx.emitOutput?.(line) });
      return { output: `Connected ${done.connector}: ClikDeploy shows an active connection. ${done.steps.filter(Boolean).join(' ')}` };
    }
    case 'read_sms_code': {
      // Only a text sent after the page was last acted on (the click that asked for it) counts, else the last three minutes; a code
      // handed out once never comes back, so a resend gets the new one. Without from, the text must name the page's site.
      const { waitForTextedCode } = await import('../computer/sms-code.js');
      const since = pageActedAt.get(page) ?? Date.now() - 180_000;
      const found = await waitForTextedCode(ctx.stateDir, { since, ...(args.seconds ? { seconds: args.seconds } : {}), ...(args.from ? { from: args.from } : { site: page.url() }), ...(ctx.signal ? { signal: ctx.signal } : {}) });
      if ('error' in found) throw new Error(found.error);
      return { output: `Code: ${found.code} (texted by ${found.from}). Type it into the page that asked for it.` };
    }
    case 'read_email_code': {
      if (await emailConnected(ctx.stateDir)) {
        // The mail arrives when the vendor sends it: wait for it instead of looking once.
        const hints = await mailboxHints(ctx.stateDir, page);
        const mail = await findEmail(ctx.stateDir, { address: args.address, hints, from: args.from, subject: args.subject, ...emailSiteScope(args, page.url()), spam: true, consume: true, accept: args.from || args.subject ? (m => emailVerificationCode(m) !== undefined) : looksLikeCodeEmail, timeoutMs: (args.seconds ?? 90) * 1000, signal: ctx.signal })
          .catch(async (error: unknown) => {
            if (!(error instanceof Error) || !/^No email matched/.test(error.message)) throw error;
            // Say where it looked: the usual cause is that the mail went to another address, not that the filter was wrong.
            throw new Error(`${error.message} Looked in ${args.address ?? (await emailStatus(ctx.stateDir)).mailboxes.map(m => m.email).join(', ')} (inbox and spam, the last 15 minutes). If the site emailed another address, connect that mailbox (email_connect with address). If the sender's name differs, leave from out: the page's site then picks the email.`);
          });
        const code = emailVerificationCode(mail);
        if (!code) throw new Error(`The email from ${args.from ?? args.subject} has no code in it. It says: "${mail.text.replace(/\s+/g, ' ').slice(0, 160)}".`);
        return { output: `Code: ${code} (read from ${mail.mailbox}). Type it into the page that asked for it.` };
      }
      // A one-time sign-up or sign-in code is short-lived and meant to be typed, so it is returned as text
      // (an API key never is). The page the code is for is left as it was: Gmail is read in a tab of its own.
      const mail = await page.context().newPage();
      try {
        const text = await (await openLatestEmail(mail, args, ctx.stateDir)).innerText();
        const code = verificationCode(text);
        if (!code) throw new Error(`The email from ${args.from ?? args.subject} has no code in it. It says: "${text.replace(/\s+/g, ' ').slice(0, 160)}".`);
        return { output: `Code: ${code} (read from ${await mailboxLabel(ctx.stateDir, args.account)}). Type it into the page that asked for it; it is already waiting in the tab you left.` };
      } finally { await mail.close().catch(quiet('agent/tools/computer-web')); }
    }
    case 'login': {
      const outcome = await loginComputerPage({ stateDir: ctx.stateDir, page, signal: ctx.signal, newAccount: args.new_account === true,
        mailCode: since => codeFromMailbox(ctx.stateDir, page.url(), since, ctx.signal),
        authenticatorCode: async () => {
          const { vendorMfaAccounts, vendorMfaAccountFor, vendorMfaCode } = await import('../computer/secret-destinations.js');
          const account = vendorMfaAccountFor(page.url(), await vendorMfaAccounts(ctx.signal));
          if (!account) return undefined;
          const code = await vendorMfaCode(account, ctx.signal);
          return 'error' in code ? undefined : code.code;
        },
        ask: async (site, fields, signal) => {
          // The profile's email and password secret answer a sign-in with no saved login; anything else is asked.
          const fromProfile = await profileLoginAnswers(ctx.stateDir, fields, args.label);
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
      const planProblem = plan?.length ? await destinationProblem(ctx.stateDir, plan, (id) => declaredConnectionValues(id, ctx.signal), (id) => declaredAuthKind(id, ctx.signal)) : undefined;
      if (planProblem) throw new Error(`${planProblem} Nothing was clicked.`);
      const codeSet = !!args.target && RECOVERY_TARGET.test(args.target.trim());
      const qrKey = !!args.target && QR_TARGET.test(args.target.trim());
      const placeholder = !!args.target && (isSecretRef(args.target) || codeSet || qrKey);
      const triggerLabel = args.target && !placeholder ? (await controlName(page, args.target)) ?? (REF.test(args.target.trim()) ? undefined : args.target.trim()) : undefined;
      const name = args.secret_name?.trim() || `${new URL(page.url()).hostname.replace(/^www\./, '')}/key`;
      // The clipboard is one thing and a Copy button only works in the focused tab: captures take turns, each in front.
      const { length, shape, via, check, sent, alreadySavedAs } = await inOrder('clipboard', async () => { await page.bringToFront().catch(quiet('agent/tools/computer-web')); return captureSecret({ ...(args.paste ? { paste: true } : {}), stateDir: ctx.stateDir, page, name, signal: ctx.signal,
        meta: { url: new URL(page.url()).origin, vendor: args.vendor ?? new URL(page.url()).hostname.replace(/^www\./, ''), owner: args.owner ?? await profileEmail(ctx.stateDir), ...(args.env ? { env: args.env } : {}) },
        ...(plan?.length ? { sendTo: plan } : {}),
        readKnown: async (last) => {
          const wanted = args.target?.trim();
          if (codeSet) {
            const found = recoveryCodesIn(await page.locator('body').innerText({ timeout: 5_000 }).catch(() => ''));
            if (!found.length) throw new LoginError('Not saved: this page shows no backup codes.');
            return { value: found.join('\n'), from: `the ${found.length} backup codes the page shows` };
          }
          if (qrKey) {
            let link: string | undefined;
            for (const frame of page.frames()) { link = otpauthIn(await frame.content().catch(() => '')); if (link) break; }
            if (!link) throw new LoginError('Not saved: the QR code on this page is a picture only, with no setup link in the page behind it. Press the page\'s "enter the key manually" or "can\'t scan?" control so the key is shown as text, then capture its placeholder.');
            return { value: link, from: 'the setup link behind the QR code' };
          }
          if (wanted && placeholder) {
            const value = resolveSecretRef(wanted);
            if (!value) throw new LoginError(`Not saved: ${wanted} is not a placeholder this browser knows (they restart with ClikCode). Observe the page again to get the current ones.`);
            // Placeholders are numbered across every tab: one from another page would send that site's secret under this one's name.
            if (!await pageHolds(page, value)) throw new LoginError(`Not saved: ${wanted} stands for a value on another page, not the one open in this tab. Observe this page and use the placeholder it shows.`);
            return { value, from: 'the page value behind the placeholder' };
          }
          if (wanted && (REF.test(wanted) || last)) return undefined; // a control is pressed; a missed label is not guessed at
          const value = await findLabelledSecret(page, wanted);
          return value ? { value, from: wanted ? `the page's "${wanted}" cell` : 'the only key value the page shows' } : undefined;
        },
        ...(args.target && !placeholder ? { trigger: async () => { await clickOrHint(await locate(page, args.target)); } } : {}),
        ...(args.target && !placeholder ? { readTarget: async () => { const element = await locate(page, args.target); return (await element.inputValue({ timeout: 1_000 }).catch(() => '')) || (await element.innerText({ timeout: 1_000 }).catch(() => '')); } } : {}),
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
      // An authenticator seed has one home. Once ClikDeploy holds it, the copy this computer kept for the hand-over is removed,
      // so a stolen laptop vault cannot make the account's codes.
      const seedOnly = !!plan?.length && plan.every(destination => destination.to === VENDOR_MFA_DESTINATION);
      const handedOver = seedOnly && !refused && sent.length > 0 && sent.every(delivery => delivery.ok)
        && await deleteNamedSecret(ctx.stateDir, alreadySavedAs ?? name).catch(() => false);
      const lines = [
        alreadySavedAs ? `ALREADY SAVED as "${alreadySavedAs}" (${length} characters, ${shape}, taken from ${via}): the same value is in ClikCode Secrets Manager, so it was not saved again and carries on to send_to. Use the name "${alreadySavedAs}" for secret: references.`
          : `SAVED "${name}" in ClikCode Secrets Manager (${length} characters, ${shape}, taken from ${via}). You were not shown the key; if that does not match what you expected (an id where a secret should be), delete it and capture again.`,
        refused ? `NOT VERIFIED: ${check.detail}. It was kept because the site shows a new key only once, and it was NOT sent anywhere. Wait a minute, then send it with send_secret and check the result.`
          : check.verdict === 'works' ? `Checked: ${check.detail}.` : `Not checked: ${check.detail}.`,
        ...(recipeLint.length ? [`Recipe saved (tidied; the recorded steps are kept in the .bak file). Still to fix: ${recipeLint.join('; ')}.`] : []),
        ...sent.map(delivery => `${delivery.ok ? 'SENT' : 'NOT SENT'} - ${delivery.label}: ${delivery.message}`),
        ...(handedOver ? ['ClikDeploy now keeps this setup key; the copy in ClikCode Secrets Manager was removed. Use auth_code with the same account for its codes.'] : []),
        ...(refused ? [] : sent.some(delivery => !delivery.ok) ? ['The key is still saved. Fix the cause, then send it again with send_secret.'] : sent.length ? [] : ['Nothing was sent anywhere: use send_to to send it on, or send_secret later.']),
      ];
      return { output: lines.join('\n'), ...(sent.some(delivery => !delivery.ok) ? { isError: true } : {}) };
    }
    case 'handoff': return handoffAction(args, ctx);
    default: throw new Error(`Unknown action "${String(args.action)}". Actions: ${ACTION_LIST}.`);
  }
}

/** show runs OUTSIDE the chat's call queue too, and is bounded (handoff-show.ts, SHOW_LIMIT_MS): it only looks at the tab, and the user
 * asked to watch now. Queued, it waited behind whatever the chat (or a sub-agent sharing its tab) was doing, a sign-in waiting on an emailed
 * code for minutes, and the agent sat with no answer (2026-11-25). Closing the view needs no tab at all. */
export async function showAction(args: Pick<WebArgs, 'tab' | 'clear'>, ctx: Pick<ToolContext, 'stateDir'>, show?: typeof import('../computer/handoff-show.js').showTab): Promise<ToolRunResult> {
  if (args.clear !== true && !(await computerEnabled(ctx.stateDir))) throw new Error(COMPUTER_OFF);
  const showTab = show ?? (await import('../computer/handoff-show.js')).showTab;
  return { output: await showTab({ stateDir: ctx.stateDir, ...(args.tab ? { tab: args.tab } : {}), ...(args.clear === true ? { clear: true } : {}) }) };
}

/**
 * The handoff: a live view of the tab for a step only the user can do, on whatever device they open the link with. It runs OUTSIDE the chat's call queue (inOrder): waiting for the user can take minutes, and every other call of
 * the chat would otherwise line up behind the wait and time out. The first call returns the link at once; a repeat call waits up to
 * 90 s for the user and, if they are not done, shows the same link again so it is never lost; `clear: true` takes the tab back.
 */
async function handoffAction(args: WebArgs, ctx: ToolContext): Promise<ToolRunResult> {
  const handoffKey = args.tab ? `${ctx.stateDir}#${args.tab}` : ctx.stateDir;
  const viaDesk = await deskHandoff(args, ctx, handoffKey);
  if (viaDesk) return viaDesk;
  let running = handoffs.get(handoffKey);
  if (args.clear === true) {
    if (!running) return { output: 'No handoff is open on this tab.' };
    running.stop.abort();
    handoffs.delete(handoffKey);
    return { output: 'The handoff is closed; the tab is yours again.' };
  }
  if (!running) {
    const stop = new AbortController();
    let resolveLink!: (link: string) => void; let failLink!: (error: Error) => void;
    const link = new Promise<string>((resolve, reject) => { resolveLink = resolve; failLink = reject; });
    link.catch(quiet('agent/tools/computer-web'));
    // The user's device reaches this computer directly over their Tailscale network: no relay, no third party.
    const host = await findTailnetAddress();
    if (!host) throw new Error('A handoff link is served on the user\'s Tailscale network, and this computer is not on one (no Tailscale address). If the user is at this computer, use show: it opens the same live view in their own browser here, and they can do the step in it. Otherwise they need Tailscale installed and signed in on this computer and on their device.');
    const done = runTailnetHandoff({ stateDir: ctx.stateDir, host, signal: stop.signal, onLink: resolveLink, ...(args.tab ? { tab: args.tab } : {}) })
      .then(() => ({ ok: true as const }), (error: unknown) => { failLink(error instanceof Error ? error : new Error(String(error))); return { ok: false as const, message: error instanceof Error ? error.message : String(error) }; })
      .finally(() => { handoffs.delete(handoffKey); });
    running = { link, done, stop };
    handoffs.set(handoffKey, running);
    // A link that never comes up ends the handoff: left in the map it would be found again with no address ("(opening)") forever.
    const url = await waitAtMost(running.link, 45_000, ctx.signal).catch((error: unknown) => { stop.abort(); if (handoffs.get(handoffKey) === running) handoffs.delete(handoffKey); throw error; });
    if (url === TIMED_OUT) { stop.abort(); if (handoffs.get(handoffKey) === running) handoffs.delete(handoffKey); throw new Error('The handoff link did not come up.'); }
    running.url = url;
    return { output: `Handoff link (a live view of this tab on the user's Tailscale network: it opens on their phone or any device on the tailnet, this computer included; reusable until Done, ends after 10 idle minutes): ${url}${await openHandoffHere(url)}\n${HANDOFF_NEXT}` };
  }
  const outcome = await waitAtMost(running.done, 90_000, ctx.signal).catch((error: unknown): typeof STOPPED => { if (error instanceof StoppedError) return STOPPED; throw error; });
  if (outcome === STOPPED) return { output: `Stopped waiting. The handoff is still open at ${running.url ?? 'its link'}; call handoff again to wait, or handoff with clear: true to take the tab back.` };
  if (outcome === TIMED_OUT) return { output: `The user has not finished yet. The link is still ${running.url ?? '(opening)'}; show it to them again. Call handoff again to keep waiting, or handoff with clear: true to take the tab back.` };
  return outcome.ok ? { output: 'The user finished the browser step. Continue from the current page.' } : { output: outcome.message, isError: true };
}

const TIMED_OUT = Symbol('timed out');
const STOPPED = Symbol('stopped');
/** `work`, or TIMED_OUT after `ms`; rejects with StoppedError when `signal` aborts. Its timer and listener are always removed. */
export function waitAtMost<T>(work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = (): void => undefined;
  const bounded = new Promise<typeof TIMED_OUT>((resolve, reject) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    onAbort = () => reject(new StoppedError());
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([work, bounded]).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); });
}

/** What the agent does with a handoff link, whichever way it was made. */
const HANDOFF_NEXT = 'Give the user the link: they do the step only they can do (a CAPTCHA, MFA, a code) in it and press Done. Then call handoff again to wait until they are done. Until then leave this tab to them; your other tabs still work. If the user only wants to watch you work, that is show, not handoff.';

/** The item each chat tab has on the handoff desk, so a repeat call waits on the same one. */
const deskWaits = sharedState('desk-handoffs', () => new Map<string, string>());

/** The handoff through the desk the browser host serves: an address that outlives this process, valid until the user taps Done.
 * Undefined when the desk is not there (an older host still running, no tailnet, a cloud tab): the caller falls back to a link of its own. */
async function deskHandoff(args: WebArgs, ctx: ToolContext, handoffKey: string): Promise<ToolRunResult | undefined> {
  const store = await import('../computer/handoff-desk-store.js');
  const info = await store.readDeskInfo(ctx.stateDir);
  if (!info) return undefined;
  const known = deskWaits.get(handoffKey);
  if (args.clear === true) {
    if (!known) return undefined;
    deskWaits.delete(handoffKey);
    await store.removeDeskItem(ctx.stateDir, known);
    return { output: 'The handoff is closed; the tab is yours again.' };
  }
  let item = known ? await store.readDeskItem(ctx.stateDir, known) : undefined;
  if (!item) {
    const { putTabOnDesk } = await import('../computer/browser.js');
    await computerPage(ctx.stateDir, args.tab);
    const label = (typeof args.label === 'string' && args.label.trim()) || (typeof args.text === 'string' && args.text.trim()) || '';
    const put = await putTabOnDesk(ctx.stateDir, args.tab, { label: label || 'Browser step', kind: 'other' });
    if (!put) return undefined;
    deskWaits.set(handoffKey, put.item.id);
    return { output: `Handoff link (a live view of this tab on the user's Tailscale network: it opens on their phone or any device on the tailnet, this computer included): ${put.address}${await openHandoffHere(put.address)}\nIt stays valid until the user presses Done, reloads included, and the tab is kept open for them for up to twelve hours even if this chat ends. Everything waiting on them is listed at ${store.deskAddress(info)} (one address that never changes). ${HANDOFF_NEXT}` };
  }
  const id = item.id;
  const polled = await waitForDeskItem(item, () => store.readDeskItem(ctx.stateDir, id), ctx.signal);
  if (polled === STOPPED) return { output: `Stopped waiting. The handoff is still open at ${store.deskItemAddress(info, id)}; call handoff again to wait, or handoff with clear: true to take the tab back.` };
  item = polled;
  if (item?.status === 'waiting') return { output: `The user has not finished yet. The link is still ${store.deskItemAddress(info, id)}; show it to them again. Call handoff again to keep waiting, or handoff with clear: true to take the tab back.` };
  deskWaits.delete(handoffKey);
  await store.removeDeskItem(ctx.stateDir, id);
  return item?.status === 'done' ? { output: 'The user finished the browser step. Continue from the current page.' } : { output: 'The handoff ended without the user finishing (it waited too long, or the tab was closed). Observe the page, and hand off again if it is still needed.', isError: true };
}

/** A handoff waits on the person: when they may be at this computer (a desktop session, not ssh), its live view is opened on the
 * desktop too, in their own browser, so the step is in front of them as well as a link away. Bounded by the opener's own settle time;
 * CLIKCODE_HANDOFF_DESKTOP=0 turns it off. Returns the sentence to add for the agent, or nothing. */
export async function openHandoffHere(url: string, deps: { env?: NodeJS.ProcessEnv; open?: (url: string, session: Record<string, string>) => Promise<boolean> } = {}): Promise<string> {
  const env = deps.env ?? process.env;
  if (env.CLIKCODE_HANDOFF_DESKTOP === '0') return '';
  const { desktopSession, remoteSession } = await import('../computer/browser-launch.js');
  const session = remoteSession(env) ? undefined : desktopSession({ env });
  if (!session) return '';
  const open = deps.open ?? (await import('../computer/handoff-show.js')).openOnDesktop;
  const opened = await open(url, session).catch(() => false);
  lifecycle('browser.handoff.desktop', { opened });
  return opened ? '\nIt is also open on this computer\'s desktop now, in the user\'s own browser: they can do the step there.' : '';
}

/** Polls a desk item while the user has not finished, up to `ms`; STOPPED as soon as `signal` aborts. */
export async function waitForDeskItem<T extends { status: string }>(item: T | undefined, read: () => Promise<T | undefined>, signal?: AbortSignal, ms = 90_000, every = 1_000): Promise<T | undefined | typeof STOPPED> {
  for (let waited = 0; item?.status === 'waiting' && waited < ms; waited += every) {
    try { await sleep(every, signal, () => new StoppedError()); }
    catch { return STOPPED; }
    item = await read();
  }
  return item;
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

/** oauth_connect values: an object of strings, or the same as JSON text; anything else is refused with what was wrong. */
function oauthValues(raw: Record<string, string> | string | undefined): Record<string, string> | undefined {
  if (raw === undefined || raw === '') return undefined;
  let value: unknown = raw;
  if (typeof raw === 'string') { try { value = JSON.parse(raw); } catch { throw new Error('oauth_connect values must be an object such as {"shop":"bobs-bikes"}.'); } }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(v => typeof v !== 'string')) throw new Error('oauth_connect values must be an object of strings such as {"shop":"bobs-bikes"}.');
  return Object.keys(value).length ? value as Record<string, string> : undefined;
}
