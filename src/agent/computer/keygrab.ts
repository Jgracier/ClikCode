/** `keygrab`: the deterministic policy for getting an API key from a vendor's site when no saved recipe fits. It signs in the way the user
 * prefers (Google, then GitHub, then the profile email with a made-up password and any emailed code), finds the API key page (menu links,
 * then common paths), presses Create/Generate (naming the key ClikDeploy), and captures the key unseen with the browser's own capture and
 * delivery. Walls only a person clears (captcha, SMS, payment, identity, approval, a refused email) end it with a human step; a screen it
 * does not know ends it with what the page showed. It never solves a captcha, never pays, and never reads or prints a key: it only drives
 * a `KeygrabPort`, so the policy is tested with a fake site. The ClikCode recorder saves the recipe as the real browser actions succeed. */
import type { HumanKind, HumanStep, StopInfo } from './connector-runner.js';
import { nextPress, pageExcerpt, type Control } from './oauth-consent.js';
import { keyShaped } from './secret-finder.js';
import { detectBlocker } from './signup-recipes.js';

export interface KeyControl { name: string; leaf?: boolean; href?: string }
/** What the page shows right now. `fields` are the visible text-like boxes (by label or placeholder), passwords included. */
export interface KeyView { url: string; text: string; controls: KeyControl[]; fields: string[]; hasPassword: boolean }

/** The browser as keygrab sees it. Every method returns an error text (or ok: false) rather than throwing for an ordinary failure. */
export interface KeygrabPort {
  open(url: string): Promise<string | undefined>;
  look(): Promise<KeyView>;
  click(name: string): Promise<string | undefined>;
  /** `text` left out: the profile or a made-up password fills it. */
  fill(name: string, text?: string): Promise<string | undefined>;
  /** The browser's own sign-in: the saved login, or the profile email and password. */
  login(): Promise<{ ok: boolean; message: string }>;
  /** The code in the newest verification email, when a mailbox is connected. */
  emailCode(): Promise<string | undefined>;
  /** Opens the link in the newest verification email in this tab. */
  emailLink(): Promise<boolean>;
  /** Captures the key unseen and sends it to ClikDeploy. `target` is a control that reveals it; none: the page already shows it. */
  capture(target?: string): Promise<{ ok: boolean; message: string }>;
  screenshot(): Promise<string | undefined>;
  profileEmail(): Promise<string | undefined>;
}

export interface KeygrabOptions { id: string; url: string; maxSteps?: number; maxMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void>; log?: (line: string) => void }
export type KeygrabResult = { ok: true; note: string; steps: number; route: string } | { ok: false; stop: StopInfo; steps: number };

export const KEY_NAME = 'ClikDeploy';
export const KEY_PATHS = ['/settings/api-keys', '/account/api', '/dashboard/api', '/developers', '/developer', '/api-keys', '/keys', '/settings/tokens'] as const;

export const GOOGLE_BUTTON = /^(?:[\w ]{0,24}?\s)?(?:with|using|via)\s+google\b|^google$/i;
export const GITHUB_BUTTON = /^(?:[\w ]{0,24}?\s)?(?:with|using|via)\s+github\b|^github$/i;
/** The brief's link test first; plain "Developers" and "API" menu items rank below it. */
export const API_LINK = /api (keys?|tokens?|credentials|developers?)/i;
const API_LINK_WEAK = /^(developers?|api|api access|developer portal|for developers|credentials|keys|tokens?|developer settings)$/i;
const SIGN_IN_ENTRY = /^(log ?in|sign ?in)$/i;
const SIGN_UP_ENTRY = /^(sign ?up|get started|get (your )?api key|register|create (an )?account|try (it )?(for )?free|start (for )?free|start building)\b[\w ]{0,15}$/i;
const CREATE = /^\W*(create|generate|new|add|get|request|issue)\b[^.]{0,30}?\b(key|token|secret|credential)s?\b/i;
const CREATE_BARE = /^\W*(create|generate|new)\W*$/i;
const NEVER_KEY = /\b(delete|revoke|remove|rotate|regenerate|roll|cancel|deactivate)\b/i;
const REVEAL = /^(show|reveal|view|copy|display)\b(?:.{0,24}\b(?:key|token|secret)\b)?\W*$/i;
const CONFIRM = /^(create|generate|save|continue|ok|done|submit|add|confirm)\b/i;
const SIGN_IN_LOOSE = /\b(sign ?up|sign ?in|log ?in|register)\b/i;
const SUBMIT = /^(sign ?up|create( account)?|register|continue|next|get started|submit)\b/i;
const NAME_FIELD = /name|label|description|title/i;
const CODE_PAGE = /(?:enter|type|paste)[^.\n]{0,40}\bcode\b|verification code|check your (?:e-?mail|inbox)|we(?:'ve| have) sent[^.\n]{0,40}(?:e-?mail|code)/i;
const RETIRED = /[^.\n]{0,60}\b(?:was|has been|is being|were) (?:retired|discontinued|shut down|sunset|deprecated)\b[^.\n]{0,60}/i;
const NOT_FOUND = /\b404\b|page (?:not found|does(?:n't| not) exist)|not found|no such page|couldn'?t find|can'?t find|\boops\b|doesn'?t exist|does not exist/i;

/** A wall only a person clears, from the page text; undefined for an ordinary page. `keyPage`: the page already offers key controls, so a stray mention of billing is not a wall. */
export function keygrabWall(text: string, keyPage = false, signInOffered = false): { kind: HumanKind; reasonCode: string; what: string } | undefined {
  const blocker = detectBlocker(text);
  if (/make an offer|buy this domain|domain(?: name)? is for sale|this domain (?:is|may be) for sale|domain for sale/i.test(text)) return { kind: 'retire', reasonCode: 'domain-for-sale', what: 'a domain-for-sale page (the vendor looks gone)' };
  if (/error 1016|origin dns error|server ip address could not be found|ERR_NAME_NOT_RESOLVED|DNS_PROBE_FINISHED|site can.t be reached|this domain (?:has )?expired/i.test(text)) return { kind: 'retire', reasonCode: 'host-dead', what: 'a site that no longer resolves (the vendor looks gone)' };
  if (blocker === 'a captcha' || /performing security verification|verifies? (?:that )?you are not a bot|checking if the site connection is secure|verify you are (?:a )?human|are you a robot|checking your browser|just a moment\.\.\./i.test(text)) return { kind: 'captcha', reasonCode: 'captcha', what: 'a captcha' };
  if (/(?:verify|confirm|enter|add)[^.\n]{0,30}(?:phone|mobile)(?: number)?|(?:sms|text message)[^.\n]{0,40}code|code[^.\n]{0,30}(?:sent|texted)[^.\n]{0,20}(?:phone|number|\+\d)|phone verification/i.test(text) && /verif|code|confirm/i.test(text)) return { kind: 'sms', reasonCode: 'phone-verification', what: 'a phone (SMS) verification' };
  if (blocker === 'an SMS or authenticator code') return { kind: 'mfa', reasonCode: 'verification-code', what: 'an authenticator or SMS code' };
  if (/identity verification|verify your identity|business verification|verify your business|\bKYC\b|know your customer|government[- ]issued|id document|passport/i.test(text)) return { kind: 'identity', reasonCode: 'identity-check', what: 'identity or business verification' };
  if (/(?:e-?mail|address)[^.\n]{0,50}(?:not allowed|not accepted|not supported|is blocked|invalid domain|not permitted)|(?:personal|free|public|gmail)[^.\n]{0,30}(?:e-?mail|address)[^.\n]{0,30}(?:not|can(?:'|no)t)|(?:work|business|company) e-?mail (?:is )?(?:required|only)|use a (?:work|business|company) e-?mail/i.test(text)) return { kind: 'decision', reasonCode: 'email-not-allowed', what: 'a refusal of the email address' };
  // Pricing, plans and billing words on a landing page that still offers sign-in are marketing, not a wall.
  if (keyPage || signInOffered) return undefined;
  if (blocker === 'a payment page' || /credit card required|enter (?:a )?valid card|upgrade to (?:a )?paid|start your (?:free )?trial/i.test(text)) return { kind: 'payment', reasonCode: 'payment', what: 'a payment page' };
  if (blocker === 'a review page' || /waitlist|wait list|pending (?:manual )?approval|manual(?:ly)? (?:review|approv)|request access|invite[- ]only|by invitation|we(?:'ll| will) (?:review|be in touch)/i.test(text)) return { kind: 'vendor-contact', reasonCode: 'approval-needed', what: 'a manual approval or waitlist' };
  return undefined;
}

const HOSTS_OF_SIGN_IN = /(^|\.)(accounts\.google\.com|google\.com|github\.com)$/i;
const hostOf = (url: string): string => { try { return new URL(url).hostname; } catch { return ''; } };
const originOf = (url: string): string => { try { return new URL(url).origin; } catch { return ''; } };
const pathOf = (url: string): string => { try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return ''; } };
const pressable = (c: KeyControl): boolean => !c.leaf && c.name.length <= 80;

class Halt extends Error { constructor(readonly stop: StopInfo) { super(stop.message); } }

export async function runKeygrab(port: KeygrabPort, options: KeygrabOptions): Promise<KeygrabResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const maxSteps = options.maxSteps ?? 40, maxMs = options.maxMs ?? 240_000;
  const began = now();
  let steps = 0;
  let route = 'none';
  const trail: string[] = [];
  let signedIn = false;
  const say = (line: string): void => options.log?.(`keygrab ${options.id}: ${line}`);

  const act = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
    if (steps >= maxSteps) throw await stop('unknown', `keygrab used its ${maxSteps}-step budget (${what})`);
    if (now() - began > maxMs) throw await stop('unknown', `keygrab used its ${Math.round(maxMs / 1000)}s budget (${what})`);
    steps++;
    trail.push(what.slice(0, 60));
    return run();
  };
  const stop = async (kind: StopInfo['kind'], message: string, human?: HumanStep, view?: KeyView): Promise<Halt> => {
    const seen = view ?? await port.look().catch((): KeyView => ({ url: '', text: '', controls: [], fields: [], hasPassword: false }));
    const screenshot = await port.screenshot().catch(() => undefined);
    return new Halt({ kind, message, url: pathOf(seen.url) || seen.url, pageText: pageExcerpt(seen.text), controls: seen.controls.filter(c => !c.leaf).map(c => c.name).slice(0, 12), ...(screenshot ? { screenshot } : {}), ...(human ? { human } : {}), trail: trail.slice(-14) });
  };
  /** Ends the run on a wall with a human step: kind, the page, and what to do. */
  const wallStop = async (view: KeyView, wall: NonNullable<ReturnType<typeof keygrabWall>>): Promise<Halt> => {
    const host = hostOf(view.url) || 'the vendor';
    const url = pathOf(view.url);
    const human: HumanStep = { kind: wall.kind, ...(url.startsWith('https://') ? { url } : {}), reasonCode: wall.reasonCode, instructions: `${host} shows ${wall.what} before ${options.id} can get a key; the runner does not bypass it and nothing was paid.` };
    return stop(wall.kind === 'captcha' ? 'captcha' : wall.kind === 'payment' ? 'payment' : wall.kind === 'mfa' || wall.kind === 'sms' ? 'mfa' : 'unknown', `${wall.what} at ${host}`, human, view);
  };
  const guard = async (view: KeyView): Promise<void> => {
    const wall = keygrabWall(view.text, view.controls.some(isCreate), !view.hasPassword && view.controls.some(c => pressable(c) && (GOOGLE_BUTTON.test(c.name) || GITHUB_BUTTON.test(c.name) || SIGN_IN_ENTRY.test(c.name) || SIGN_UP_ENTRY.test(c.name))));
    if (wall) throw await wallStop(view, wall);
  };
  const look = async (): Promise<KeyView> => {
    let v = await port.look();
    // A page still loading shows nothing yet: give it a few seconds before judging it.
    for (let wait = 0; wait < 4 && ((!v.controls.length && v.text.trim().length < 40) || (/\b(?:loading|just a minute|please wait)\b/i.test(v.text) && v.text.length < 400 && v.controls.length < 6)); wait++) { await sleep(1_500); v = await port.look(); }
    await guard(v);
    return v;
  };
  const click = async (name: string): Promise<boolean> => { const err = await act(`click ${name}`, () => port.click(name)); if (err) say(`could not click "${name}"`); return !err; };

  const isCreate = (c: KeyControl): boolean => pressable(c) && !NEVER_KEY.test(c.name) && (CREATE.test(c.name) || CREATE_BARE.test(c.name));
  const createOf = (v: KeyView): KeyControl | undefined => {
    if (offersSignIn(v)) return undefined; // "Get API key" before signing in is a sign-up link
    const exact = v.controls.find(c => pressable(c) && !NEVER_KEY.test(c.name) && CREATE.test(c.name));
    if (exact) return exact;
    return /\b(api|key|token)/i.test(v.text) ? v.controls.find(c => pressable(c) && !NEVER_KEY.test(c.name) && CREATE_BARE.test(c.name)) : undefined;
  };
  const revealOf = (v: KeyView): KeyControl | undefined => offersSignIn(v) ? undefined : /\b(api|key|token|secret)/i.test(v.text) ? v.controls.find(c => pressable(c) && REVEAL.test(c.name)) : undefined;
  // A landing page that still offers sign-in shows no key of ours, whatever its text looks like.
  const offersSignIn = (v: KeyView): boolean => !v.hasPassword ? v.controls.some(c => pressable(c) && (GOOGLE_BUTTON.test(c.name) || GITHUB_BUTTON.test(c.name) || SIGN_IN_ENTRY.test(c.name) || SIGN_UP_ENTRY.test(c.name))) : true;
  const showsKey = (v: KeyView): boolean => !offersSignIn(v) && /\b(api[- ]?keys?|secret|token|access key)\b/i.test(v.text) && v.text.split(/\s+/).some(word => keyShaped(word.replace(/^[("'`]+|[)"'`,.;]+$/g, '')));
  const isKeyPage = (v: KeyView): boolean => !!createOf(v) || !!revealOf(v) || showsKey(v);
  const findOne = (v: KeyView, re: RegExp): KeyControl | undefined => v.controls.find(c => pressable(c) && re.test(c.name.replace(/\s*last used\s*$/i, '').trim()));
  const hasEntry = (v: KeyView): boolean => !!findOne(v, SIGN_IN_ENTRY) || !!findOne(v, SIGN_UP_ENTRY) || !!findOne(v, SIGN_IN_LOOSE);
  const authWall = (v: KeyView): boolean => !isKeyPage(v) && (v.hasPassword || !!findOne(v, GOOGLE_BUTTON) || !!findOne(v, GITHUB_BUTTON) || (v.fields.some(f => /e-?mail/i.test(f)) && v.controls.some(c => pressable(c) && SUBMIT.test(c.name))));

  /** Press through a provider's own screens (Google account chooser and consent, GitHub authorize) until back on the vendor. */
  const providerScreens = async (): Promise<void> => {
    const email = await port.profileEmail().catch(() => undefined);
    let idle = 0, chosenOn = '';
    for (let round = 0; round < 10; round++) {
      await sleep(600);
      const v = await look();
      const host = hostOf(v.url);
      if (!HOSTS_OF_SIGN_IN.test(host)) return;
      if (v.hasPassword) {
        if (/github\.com$/i.test(host)) {
          const done = await act('sign in to GitHub with the saved login', () => port.login());
          if (!done.ok) throw await stop('password', `GitHub needs a sign-in the runner cannot do: ${done.message}`, { kind: 'worker-setup', url: 'https://github.com/login', reasonCode: 'sign-in-needed', instructions: 'Sign the ClikCode browser in to GitHub once (saved login), then run the connectors again.' }, v);
          continue;
        }
        throw await stop('password', 'Google asks for a password: the ClikCode browser is signed out of Google', { kind: 'worker-setup', url: 'https://accounts.google.com/', reasonCode: 'sign-in-needed', instructions: 'Sign the ClikCode browser in to Google once, then run the connectors again.' }, v);
      }
      const controls: Control[] = v.controls.map(c => ({ name: c.name, leaf: c.leaf === true }));
      const next = nextPress(host, controls, v.text, { ...(email ? { email } : {}), skipAccount: chosenOn === pathOf(v.url) });
      const target = next && controls[next.index];
      if (!target || !next) { if (++idle >= 3) throw await stop('unknown', `a ${host} screen the runner does not know`, undefined, v); continue; }
      idle = 0;
      if (next.note === 'Chose the account.') chosenOn = pathOf(v.url);
      // A chooser row is the name run into the address; the address alone is what the page's text matches.
      if (next.note === 'Chose the account.' && email && target.name.toLowerCase().includes(email.toLowerCase())) await click(email);
      else await click(target.name);
    }
  };

  const verifyEmail = async (): Promise<void> => {
    for (let round = 0; round < 2; round++) {
      const v = await look();
      if (!CODE_PAGE.test(v.text)) return;
      const code = await act('read the emailed code', () => port.emailCode());
      if (code) {
        const field = v.fields.find(f => /code|otp|token/i.test(f)) ?? v.fields[0];
        if (field) await act('type the emailed code', () => port.fill(field, code));
        const go = [...v.controls].reverse().find(c => pressable(c) && /^(verify|confirm|continue|submit|next)\b/i.test(c.name));
        if (go) await click(go.name);
        await sleep(800);
        continue;
      }
      if (!(await act('open the emailed link', () => port.emailLink()))) throw await stop('unknown', 'the vendor wants an emailed code or link and none could be read', undefined, v);
      await sleep(800);
    }
  };

  const emailRoute = async (v: KeyView): Promise<void> => {
    route = 'email';
    const done = await act('sign in with the profile email', () => port.login());
    if (done.ok) return;
    // No account yet (or no saved login): fill the form from the profile, with a made-up password, and submit it.
    const here = await look();
    for (const field of here.fields.length ? here.fields : v.fields) await act(`fill ${field}`, () => port.fill(field));
    const submit = [...here.controls].reverse().find(c => pressable(c) && SUBMIT.test(c.name));
    if (!submit) throw await stop('unknown', `the sign-in form has no button the runner knows (${done.message})`, undefined, here);
    await click(submit.name);
    await sleep(800);
    await verifyEmail();
  };

  /** Sign in to the vendor from whatever sign-in or sign-up screen is showing. */
  const authenticate = async (): Promise<void> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const v = await look();
      const google = findOne(v, GOOGLE_BUTTON);
      if (google) { route = 'google'; await click(google.name); await providerScreens(); await verifyEmail(); signedIn = true; return; }
      const github = findOne(v, GITHUB_BUTTON);
      if (github) { route = 'github'; await click(github.name); await providerScreens(); await verifyEmail(); signedIn = true; return; }
      if (v.hasPassword || v.fields.some(f => /e-?mail/i.test(f))) { await emailRoute(v); signedIn = true; return; }
      const entry = findOne(v, SIGN_UP_ENTRY) ?? findOne(v, SIGN_IN_ENTRY) ?? findOne(v, SIGN_IN_LOOSE);
      if (!entry) break;
      await click(entry.name);
      await sleep(600);
    }
    throw await stop('unknown', 'no way to sign in was found on the page');
  };

  const openAt = async (url: string): Promise<KeyView | undefined> => {
    const err = await act(`open ${pathOf(url)}`, () => port.open(url));
    if (err) { say(`could not open ${pathOf(url)}`); return undefined; }
    return look();
  };

  /** Walks to the API key page: menu items that read like one, then the common paths. Returns the view of the page that offers a key. */
  const findKeyPage = async (start: KeyView): Promise<KeyView> => {
    let v = start;
    let shown = start; // the last page that was a real page, for the report if nothing is found
    if (isKeyPage(v)) return v;
    const links = [
      ...v.controls.filter(c => pressable(c) && !NEVER_KEY.test(c.name) && API_LINK.test(c.name)),
      ...v.controls.filter(c => pressable(c) && !NEVER_KEY.test(c.name) && !API_LINK.test(c.name) && API_LINK_WEAK.test(c.name)),
    ].filter((c, i, all) => all.findIndex(o => o.name === c.name) === i).slice(0, 3);
    for (const link of links) {
      if (!(await click(link.name))) continue;
      await sleep(700);
      v = await look();
      if (authWall(v) && !signedIn) { await authenticate(); v = await look(); }
      if (isKeyPage(v)) return v;
      shown = v;
    }
    const origins = [...new Set([originOf(v.url), originOf(options.url)].filter(o => o && !HOSTS_OF_SIGN_IN.test(hostOf(o))))];
    for (const origin of origins) {
      for (const path of KEY_PATHS) {
        let page = await openAt(`${origin}${path}`);
        if (!page || NOT_FOUND.test(page.text.slice(0, 400))) continue;
        if (authWall(page) && !signedIn) { await authenticate(); page = await openAt(`${origin}${path}`); if (!page) continue; }
        if (isKeyPage(page)) return page;
        shown = page;
      }
    }
    const gone = RETIRED.exec(start.text)?.[0];
    const human: HumanStep | undefined = gone ? { kind: 'retire', ...(pathOf(start.url).startsWith('https://') ? { url: pathOf(start.url) } : {}), reasonCode: 'vendor-retired', instructions: `${hostOf(start.url)} says "${gone.slice(0, 120)}" and has no API key page; confirm and retire the connector.` } : undefined;
    throw await stop('unknown', 'no API key page was found (menu links and the common paths were tried)', human, shown);
  };

  const captured = async (target?: string): Promise<{ ok: boolean; message: string }> => act('capture the key', () => port.capture(target));

  try {
    const first = await openAt(options.url);
    if (!first) throw await stop('unknown', `could not open ${pathOf(options.url)}`);
    let v = first;
    // An API host (no controls at all, a bare JSON error) is not the vendor's site: start from its parent domain.
    const labels = hostOf(v.url).split('.');
    if (!v.controls.length && !v.fields.length && labels.length > 2) {
      const apex = await openAt(`https://${labels.slice(1).join('.')}/`);
      if (apex) v = apex;
    }
    // A page that offers sign-in and no key controls: sign in first, then look for the key page.
    if (authWall(v) || (!isKeyPage(v) && hasEntry(v))) { await authenticate(); v = await look(); }
    let page = await findKeyPage(v);
    for (let retry = 0; retry < 2; retry++) {
      if (showsKey(page) && !createOf(page)) { const got = await captured(); if (got.ok) return { ok: true, note: `key captured from ${pathOf(page.url)} and sent to ClikDeploy; it was not shown`, steps, route }; }
      const create = createOf(page);
      if (create) {
        await click(create.name);
        await sleep(700);
        let dialog = await look();
        const nameBox = dialog.fields.find(f => NAME_FIELD.test(f)) ?? (dialog.fields.length === 1 && !dialog.hasPassword ? dialog.fields[0] : undefined);
        if (nameBox && !showsKey(dialog)) {
          await act(`name the key ${KEY_NAME}`, () => port.fill(nameBox, KEY_NAME));
          const confirm = [...dialog.controls].reverse().find(c => pressable(c) && CONFIRM.test(c.name) && !NEVER_KEY.test(c.name));
          if (confirm) { await click(confirm.name); await sleep(900); dialog = await look(); }
        }
        let got = await captured();
        if (!got.ok) {
          const reveal = revealOf(dialog);
          if (reveal) got = await captured(reveal.name);
        }
        if (got.ok) return { ok: true, note: 'key created (named ClikDeploy), captured unseen and sent to ClikDeploy', steps, route };
        throw await stop('unknown', `a key may have been created but could not be captured: ${got.message.slice(0, 200)}`, undefined, dialog);
      }
      const reveal = revealOf(page);
      if (reveal) {
        const got = await captured(reveal.name);
        if (got.ok) return { ok: true, note: `key revealed with "${reveal.name}", captured unseen and sent to ClikDeploy`, steps, route };
        throw await stop('unknown', `the key could not be captured: ${got.message.slice(0, 200)}`, undefined, page);
      }
      page = await look();
    }
    throw await stop('unknown', 'the key page offers nothing the runner knows to press', undefined, page);
  } catch (error) {
    if (error instanceof Halt) return { ok: false, stop: error.stop, steps };
    throw error;
  }
}
