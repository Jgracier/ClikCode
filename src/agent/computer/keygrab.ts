/** `keygrab`: the deterministic policy for getting an API key from a vendor's site when no saved recipe fits. It signs in the way the user
 * prefers (Google, then GitHub, then the profile email with a made-up password and any emailed code), finds the API key page (menu links,
 * then common paths), presses Create/Generate (naming the key ClikDeploy), and captures the key unseen with the browser's own capture and
 * delivery. Walls only a person clears (captcha, SMS, payment, identity, approval, a refused email) end it with a human step; a screen it
 * does not know ends it with what the page showed. It never solves a captcha, never pays, and never reads or prints a key: it only drives
 * a `KeygrabPort`, so the policy is tested with a fake site. The ClikCode recorder saves the recipe as the real browser actions succeed. */
import { quiet } from '../../runtime/lifecycle-log.js';
import type { HumanKind, HumanStep, StopInfo } from './connector-runner.js';
import { nextPress, pageExcerpt, type Control } from './oauth-consent.js';
import { keyShaped } from './secret-finder.js';
import { detectBlocker } from './signup-recipes.js';
import { allAtOnce, broadestOption, revealedOptions, selectorsOf } from './keygrab-scope.js';
import { exploreForKeys, menuOpeners } from './keygrab-explore.js';

export interface KeyControl { name: string; leaf?: boolean; href?: string; /** Inside the page footer (social and legal links live there, not sign-in). */ footer?: boolean; /** Inside a navigation or side bar. */ nav?: boolean; /** Opens a menu (aria-haspopup or aria-expanded). */ menu?: boolean; /** Found inside an iframe (same-origin or not). */ frame?: boolean }
/** What the page shows right now. `fields` are the visible text-like boxes (by label or placeholder), passwords included. */
export interface KeyView { url: string; text: string; controls: KeyControl[]; fields: string[]; hasPassword: boolean; /** A real, visible captcha challenge frame (not an invisible badge). */ captchaFrame?: boolean }

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
  /** A cheap fetch (no browser): whether the address answers with an HTML page, and where it ended up after redirects. */
  probe?(url: string): Promise<{ html: boolean; status: number; url: string } | undefined>;
  /** Presses a key on the page (Escape closes a menu, Enter submits a search). */
  press?(key: string): Promise<string | undefined>;
  screenshot(): Promise<string | undefined>;
  profileEmail(): Promise<string | undefined>;
}

export interface KeygrabOptions { id: string; url: string; /** Continue from the page the browser is on (a resumed run): no start page is opened. */ resume?: { visited?: string[]; menus?: string[]; signedIn?: boolean }; /** Most pages post-login exploration follows (default 8). */ exploreMax?: number; /** Other starting points to try when `url` is no web page (the spec's homepage, sign-up and docs addresses). */ alternates?: string[]; maxSteps?: number; maxMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void>; log?: (line: string) => void }
export type KeygrabResult = { ok: true; note: string; steps: number; route: string } | { ok: false; stop: StopInfo; steps: number };

export const KEY_NAME = 'ClikDeploy';
export const KEY_PATHS = ['/settings/api-keys', '/account/api', '/dashboard/api', '/developers', '/developer', '/api-keys', '/keys', '/settings/tokens'] as const;

export const GOOGLE_BUTTON = /^(?:[\w ]{0,24}?\s)?(?:with|using|via)\s+google\b|^google$/i;
export const GITHUB_BUTTON = /^(?:[\w ]{0,24}?\s)?(?:with|using|via)\s+github\b|^github$/i;
/** A social or share link to the provider's own site (a footer icon), not a sign-in button. */
const SOCIAL_HOST = /(^|\.)(github\.com|google\.com|plus\.google\.com)$/i;
/** "Continue with Google" style first, a bare provider name last. */
const providerRank = (c: KeyControl): number => /\b(continue|sign ?in|sign ?up|log ?in|login|register|connect|start)\b/i.test(c.name) ? 0 : /\b(with|using|via)\b/i.test(c.name) ? 1 : 2;
/** The brief's link test first; plain "Developers" and "API" menu items rank below it. */
export const API_LINK = /api (keys?|tokens?|credentials|developers?)/i;
/** "Word Associations API Account", "API console": the way into the vendor's API area, ranked between the key links and the bare ones. */
const API_LINK_AREA = /\bapi\b[^.]{0,30}\b(?:account|portal|console|dashboard|access|sign ?up|register)\b|\b(?:developer|api) (?:portal|console|dashboard|account)\b/i;
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
/** The press that finishes a first sign-in with a provider: "By proceeding, I agree to the Terms" + "Complete registration", with nothing to type. */
const TERMS_NOTICE = /by (?:proceeding|continuing|clicking|signing up|registering)[^.\n]{0,60}\b(?:agree|accept)|\b(?:agree|accept)[^.\n]{0,40}(?:terms|privacy)/i;
const COMPLETE_SIGNUP = /^(?:complete (?:your )?(?:registration|sign ?up|account(?: setup)?|setup|profile)|finish(?: sign ?up| setup| registration)?|accept(?: and continue)?|agree(?: and continue)?|i agree|create (?:my )?account|continue)$/i;
const NAME_FIELD = /name|label|description|title/i;
const CODE_PAGE = /(?:enter|type|paste)[^.\n]{0,40}\bcode\b|verification code|check your (?:e-?mail|inbox)|we(?:'ve| have) sent[^.\n]{0,40}(?:e-?mail|code)/i;
const RETIRED = /[^.\n]{0,60}\b(?:was|has been|is being|were) (?:retired|discontinued|shut down|sunset|deprecated)\b[^.\n]{0,60}/i;
const NOT_FOUND = /\b404\b|page (?:not found|does(?:n't| not) exist)|not found|no such page|couldn'?t find|can'?t find|\boops\b|doesn'?t exist|does not exist/i;

/** Strong evidence only. A pricing page, a tier table, "No credit card required" or an FAQ about billing is marketing, not a wall. */
const CAPTCHA_TEXT = /(?:let's|let us) confirm you are (?:a )?human|complete the security check before continuing|verify (?:that )?you(?:'re| are) (?:a )?human|i'?m not a robot|are you a robot|complete the (?:captcha|security check)|solve (?:the|this) captcha|select all (?:images|squares)|press (?:and|&) hold|performing security verification|verifies? (?:that )?you are not a bot|checking if the site connection is secure|checking your browser|just a moment\.\.\./i;
/** A box that asks to retype distorted characters or answer a human check is a captcha, whatever frame it is in: never filled. */
const CAPTCHA_FIELD = /type the (?:characters|letters|text|code|word)s? (?:you see|shown|in the image|below)|enter the (?:characters|letters|text|code) (?:you see|shown|in the image|below)|captcha|security (?:code|check|question)|are you (?:a )?human|not a robot/i;
const PAYMENT_TEXT = /enter your (?:credit |debit )?card|(?:credit |debit )?card (?:number|details) (?:is )?required|\bcard number\b|\bcvc\b|\bcvv\b|expir(?:y|ation) date|payment method (?:is )?required|(?:add|enter) (?:a )?(?:valid )?payment method to (?:continue|proceed|get)|(?<!\bno )(?<!\bwithout a )credit card (?:is )?required(?! for)|enter (?:a )?valid card/i;
const PAYMENT_FIELD = /card number|\bcvc\b|\bcvv\b|expir(?:y|ation)|name on card/i;
const IDENTITY_STRONG = /verify your (?:identity|id\b|business)|confirm your identity|(?:upload|scan|take|submit)[^.\n]{0,40}(?:passport|driver'?s licen[cs]e|government[- ]issued|id (?:card|document))|please (?:provide|submit)[^.\n]{0,30}(?:business|company) (?:verification|registration)/i;
const IDENTITY_WEAK = /identity verification|business verification|verify your business|\bKYC (?:check|verification|process|required|documents?)|know your customer (?:check|verification|process)/i;
/** The identity wall words the runner shares: the strong evidence only. */
export const IDENTITY_WALL = new RegExp(`${IDENTITY_STRONG.source}|${IDENTITY_WEAK.source}`, 'i');

/** A wall only a person clears, from the page; undefined for an ordinary page. `keyPage`: the page already offers key controls, so a stray mention of billing is not a wall. */
export function keygrabWall(text: string, keyPage = false, signInOffered = false, extra: { captchaFrame?: boolean; fields?: string[] } = {}): { kind: HumanKind; reasonCode: string; what: string } | undefined {
  const blocker = detectBlocker(text);
  if (/make an offer|buy this domain|domain(?: name)? is for sale|this domain (?:is|may be) for sale|domain for sale/i.test(text)) return { kind: 'retire', reasonCode: 'domain-for-sale', what: 'a domain-for-sale page (the vendor looks gone)' };
  if (/error 1016|origin dns error|server ip address could not be found|ERR_NAME_NOT_RESOLVED|DNS_PROBE_FINISHED|site can.t be reached|this domain (?:has )?expired/i.test(text)) return { kind: 'retire', reasonCode: 'host-dead', what: 'a site that no longer resolves (the vendor looks gone)' };
  if (extra.captchaFrame || CAPTCHA_TEXT.test(text) || (extra.fields ?? []).some(f => CAPTCHA_FIELD.test(f))) return { kind: 'captcha', reasonCode: 'captcha', what: 'a captcha' };
  // "Verify your identity ... a verification email will follow" over name and email boxes is a sign-up form (HERE), not a document check.
  const signUpForm = /verification e-?mail|we(?:'ll| will) e-?mail you/i.test(text) && (extra.fields ?? []).some(f => /e-?mail/i.test(f)) && !/passport|licen[cs]e|upload|government/i.test(text);
  if (!signUpForm && IDENTITY_STRONG.test(text) || (!keyPage && !signInOffered && IDENTITY_WEAK.test(text))) return { kind: 'identity', reasonCode: 'identity-check', what: 'identity or business verification' };
  if (/(?:e-?mail|address)[^.\n]{0,50}(?:not allowed|not accepted|not supported|is blocked|invalid domain|not permitted)|(?:personal|free|public|gmail)[^.\n]{0,30}(?:e-?mail|address)[^.\n]{0,30}(?:not|can(?:'|no)t)|(?:work|business|company) e-?mail (?:is )?(?:required|only)|use a (?:work|business|company) e-?mail/i.test(text)) return { kind: 'decision', reasonCode: 'email-not-allowed', what: 'a refusal of the email address' };
  // A card form (a card-number box, "enter your card") is a payment wall wherever it shows; pricing words never are.
  if (!keyPage && ((extra.fields ?? []).some(f => PAYMENT_FIELD.test(f)) || PAYMENT_TEXT.test(text))) return { kind: 'payment', reasonCode: 'payment', what: 'a payment page' };
  if (keyPage || signInOffered) return undefined;
  if (/(?:verify|confirm|enter|add)[^.\n]{0,30}(?:phone|mobile)(?: number)?|(?:sms|text message)[^.\n]{0,40}code|code[^.\n]{0,30}(?:sent|texted)[^.\n]{0,20}(?:phone|number|\+\d)|phone verification/i.test(text) && /verif|code|confirm/i.test(text)) return { kind: 'sms', reasonCode: 'phone-verification', what: 'a phone (SMS) verification' };
  if (blocker === 'an SMS or authenticator code') return { kind: 'mfa', reasonCode: 'verification-code', what: 'an authenticator or SMS code' };
  if (blocker === 'a review page' || /waitlist|wait list|pending (?:manual )?approval|manual(?:ly)? (?:review|approv)|request access|invite[- ]only|by invitation|we(?:'ll| will) (?:review|be in touch)/i.test(text)) return { kind: 'vendor-contact', reasonCode: 'approval-needed', what: 'a manual approval or waitlist' };
  return undefined;
}

/** Cookie and consent banners: the least permissive button that exists. A bare "OK" or "Got it" counts only where the page speaks of cookies. */
const BANNER_TEXT = /cookie|consent|privacy|gdpr/i;
const BANNER_REJECT = /^(?:reject(?: all)?(?: cookies)?|decline(?: all)?(?: cookies)?|deny(?: all)?|refuse(?: all)?|(?:use |accept |allow )?(?:only )?(?:strictly )?(?:necessary|essential|required)(?: cookies)?(?: only)?|only (?:necessary|essential|required)(?: cookies)?|continue without accepting|no,? thanks)$/i;
const BANNER_ACCEPT = /^(?:accept(?: all)?(?: cookies)?|allow(?: all)?(?: cookies)?|i agree|agree(?: and (?:continue|close|proceed))?|got it|ok(?:ay)?|i understand|understood)$/i;
const BANNER_ACCEPT_BARE = /^(?:ok(?:ay)?|got it|agree|i understand|understood)$/i;
/** The banner button to press on this page, or undefined when there is no banner. */
export function bannerButton(view: Pick<KeyView, 'text' | 'controls'>): KeyControl | undefined {
  if (!BANNER_TEXT.test(view.text)) return undefined;
  const live = view.controls.filter(c => !c.leaf && c.name.length <= 40);
  const reject = live.find(c => BANNER_REJECT.test(c.name.trim()));
  if (reject) return reject;
  const cookies = /cookie|consent/i.test(view.text);
  return live.find(c => BANNER_ACCEPT.test(c.name.trim()) && (cookies || !BANNER_ACCEPT_BARE.test(c.name.trim())));
}

/** A "choose the product and sign in" page (Musixmatch: Community, Pro, Platform): the options and the one a key comes from. */
const CHOOSER_TEXT = /\b(?:choose|select|pick) (?:the |a |your )?(?:product|plan|account(?: type)?|option|portal|service)\b[^.\n]{0,30}(?:sign ?in|log ?in|continue)?/i;
const CHOOSER_PREFERRED = /\b(?:api|developers?)\b|^(?:community|free|developer|self[- ]serve|personal|individual|basic|starter|hobby)\b/i;
export function chooserOptions(view: Pick<KeyView, 'text' | 'controls'>): { options: KeyControl[]; pick?: KeyControl } | undefined {
  if (!CHOOSER_TEXT.test(view.text)) return undefined;
  // The options are the page's own cards: text pieces (buttons or plain boxes) that follow the heading in the page text.
  const after = view.text.slice(Math.max(0, view.text.search(CHOOSER_TEXT)));
  const options = view.controls.filter(c => c.name.length <= 80 && !c.footer && after.includes(c.name.slice(0, 20)) && !CHOOSER_TEXT.test(c.name) && !/^(?:sign ?in|log ?in|continue|discover|search|pricing|about|documentation|status)$/i.test(c.name));
  const pick = options.find(c => CHOOSER_PREFERRED.test(c.name) && !/^(?:pro|platform)\b/i.test(c.name));
  return { options, ...(pick ? { pick } : {}) };
}

/** Where to start when the given address is no web page: nearer candidates first. `test` is a cheap fetch. */
export function startCandidates(url: string, alternates: string[] = []): string[] {
  const out: string[] = [];
  const add = (u: string): void => { if (u && !out.includes(u)) out.push(u); };
  add(url);
  for (const alt of alternates) add(alt);
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { return out; }
  const labels = host.split('.');
  const second = new Set(['co', 'com', 'org', 'net', 'gov', 'ac']);
  const keep = labels.length > 2 && second.has(labels[labels.length - 2]!) && labels[labels.length - 1]!.length === 2 ? 3 : 2;
  for (let i = 1; labels.length - i >= keep; i++) add(`https://${labels.slice(i).join('.')}/`);
  const root = labels.slice(-keep).join('.');
  add(`https://developer.${root}/`);
  add(`https://developers.${root}/`);
  for (const path of ['/developers', '/signup', '/register', '/login', '/account']) add(`https://${root}${path}`);
  return out;
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
  const maxSteps = options.maxSteps ?? 60, maxMs = options.maxMs ?? 240_000;
  const began = now();
  let steps = 0;
  let route = 'none';
  const trail: string[] = [];
  let authTries = 0;
  const visited: string[] = [...(options.resume?.visited ?? [])];
  const menus: string[] = [...(options.resume?.menus ?? [])];
  const triedNames = new Set<string>();
  const sink = options.log ?? (process.env.CLIKCODE_KEYGRAB_LOG ? (line: string): void => void process.stderr.write(`${line}\n`) : undefined);
  const say = (line: string): void => sink?.(`keygrab ${options.id}: ${line}`);

  const act = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
    if (steps >= maxSteps) throw await stop('unknown', `keygrab used its ${maxSteps}-step budget (${what})`);
    if (now() - began > maxMs) throw await stop('unknown', `keygrab used its ${Math.round(maxMs / 1000)}s budget (${what})`);
    steps++;
    trail.push(what.slice(0, 80));
    say(`${steps}: ${what.slice(0, 80)}`);
    return run();
  };
  const stop = async (kind: StopInfo['kind'], message: string, human?: HumanStep, view?: KeyView): Promise<Halt> => {
    const seen = view ?? await port.look().catch((): KeyView => ({ url: '', text: '', controls: [], fields: [], hasPassword: false }));
    const screenshot = await port.screenshot().catch(quiet('agent/computer/keygrab'));
    return new Halt({ kind, message, url: pathOf(seen.url) || seen.url, pageText: pageExcerpt(seen.text), controls: seen.controls.filter(c => !c.leaf).map(c => c.name).slice(0, 12), ...(screenshot ? { screenshot } : {}), ...(human ? { human } : {}), trail: trail.slice(-30), actions: steps, ...(signedIn ? { signedIn: true } : {}), ...(visited.length ? { visited: visited.slice(-30) } : {}), ...(menus.length ? { menus: menus.slice(-12) } : {}) });
  };
  /** Ends the run on a wall with a human step: kind, the page, and what to do. */
  const wallStop = async (view: KeyView, wall: NonNullable<ReturnType<typeof keygrabWall>>): Promise<Halt> => {
    const host = hostOf(view.url) || 'the vendor';
    const url = pathOf(view.url);
    const human: HumanStep = { kind: wall.kind, ...(url.startsWith('https://') ? { url } : {}), reasonCode: wall.reasonCode, instructions: `${host} shows ${wall.what} before ${options.id} can get a key; the runner does not bypass it and nothing was paid.` };
    return stop(wall.kind === 'captcha' ? 'captcha' : wall.kind === 'payment' ? 'payment' : wall.kind === 'mfa' || wall.kind === 'sms' ? 'mfa' : 'unknown', `${wall.what} at ${host}`, human, view);
  };
  // A page that shows only its footer (legal links) is a shell still loading, not a page with nothing to offer.
  const bareShell = (v: KeyView): boolean => v.text.trim().length < 300 && !v.fields.length && !v.controls.some(c => !c.footer && !/terms|privacy|cookie|consent|status|contact|©|policy/i.test(c.name));
  let banners = 0;
  const dismissBanner = async (v: KeyView): Promise<KeyView> => {
    for (let round = 0; round < 2 && banners < 4; round++) {
      const button = bannerButton(v);
      if (!button) return v;
      banners++;
      const err = await act(`dismiss the cookie banner (${button.name})`, () => port.click(button.name));
      if (err) return v;
      await sleep(400);
      v = await port.look();
    }
    return v;
  };
  const guard = async (view: KeyView): Promise<void> => {
    const wall = keygrabWall(view.text, view.controls.some(isCreate), offersSignIn(view), { ...(view.captchaFrame ? { captchaFrame: true } : {}), fields: view.fields });
    if (wall) throw await wallStop(view, wall);
  };
  const look = async (): Promise<KeyView> => {
    let v = await port.look();
    // A page still loading shows nothing yet: give it a few seconds before judging it.
    for (let wait = 0; wait < 6 && ((!v.controls.length && v.text.trim().length < 40) || bareShell(v) || (/\b(?:loading|just a minute|please wait)\b/i.test(v.text) && v.text.length < 400 && v.controls.length < 6)); wait++) { await sleep(1_500); v = await port.look(); }
    v = await dismissBanner(v);
    await guard(v);
    const here = pathOf(v.url);
    if (here && !visited.includes(here) && visited.length < 60) visited.push(here);
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
  const offersSignIn = (v: KeyView): boolean => !v.hasPassword ? providerButtons(v, GOOGLE_BUTTON).length > 0 || providerButtons(v, GITHUB_BUTTON).length > 0 || v.controls.some(c => pressable(c) && !c.footer && (SIGN_IN_ENTRY.test(c.name) || SIGN_UP_ENTRY.test(c.name))) : true;
  const showsKey = (v: KeyView): boolean => !offersSignIn(v) && /\b(api[- ]?keys?|secret|token|access key)\b/i.test(v.text) && v.text.split(/\s+/).some(word => keyShaped(word.replace(/^[("'`]+|[)"'`,.;]+$/g, '')));
  const isKeyPage = (v: KeyView): boolean => !!createOf(v) || !!revealOf(v) || showsKey(v);
  const hasEntry = (v: KeyView): boolean => !!entryOf(v, SIGN_IN_ENTRY) || !!entryOf(v, SIGN_UP_ENTRY) || !!entryOf(v, SIGN_IN_LOOSE);
  const signEntry = (v: KeyView): boolean => !!entryOf(v, SIGN_IN_ENTRY) || !!entryOf(v, SIGN_UP_ENTRY);
  const authWall = (v: KeyView): boolean => !isKeyPage(v) && (v.hasPassword || !!chooserOptions(v) || providerButtons(v, GOOGLE_BUTTON).length > 0 || providerButtons(v, GITHUB_BUTTON).length > 0 || (v.fields.some(f => /e-?mail/i.test(f)) && v.controls.some(c => pressable(c) && SUBMIT.test(c.name))));

  /** Press through a provider's own screens (Google account chooser and consent, GitHub authorize) until back on the vendor. */
  const providerScreens = async (): Promise<void> => {
    const email = await port.profileEmail().catch(quiet('agent/computer/keygrab'));
    let idle = 0, chosen = false;
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
      const next = nextPress(host, controls, v.text, { ...(email ? { email } : {}), skipAccount: chosen });
      const target = next && controls[next.index];
      if (!target || !next) { if (++idle >= 3) throw await stop('unknown', `a ${host} screen the runner does not know`, undefined, v); continue; }
      idle = 0;
      if (next.note === 'Chose the account.') chosen = true;
      // A chooser row is the name run into the address; the address alone is what the page's text matches.
      if (next.note === 'Chose the account.' && email && target.name.toLowerCase().includes(email.toLowerCase())) await click(email);
      else await click(target.name);
    }
    // Ten screens and still at the provider: say so rather than carrying on as if signed in.
    const last = await look();
    if (HOSTS_OF_SIGN_IN.test(hostOf(last.url))) throw await stop('unknown', `still on a ${hostOf(last.url)} screen after pressing through it`, undefined, last);
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
    // No account yet (or no saved login). On a log-in page the way forward is its sign-up link; then the form is filled from the profile, with a made-up password.
    let here = await look();
    const onLogin = here.controls.some(c => pressable(c) && /^(log ?in|sign ?in)$/i.test(c.name));
    const toSignUp = onLogin ? here.controls.find(c => pressable(c) && /sign ?up|create (an )?account|register|get started/i.test(c.name) && !/^(log ?in|sign ?in)$/i.test(c.name)) : undefined;
    if (toSignUp && await click(toSignUp.name)) { await sleep(800); here = await look(); }
    for (const field of here.fields.length ? here.fields : v.fields) await act(`fill ${field}`, () => port.fill(field));
    const submit = [...here.controls].reverse().find(c => pressable(c) && /^(sign ?up|create( account)?|register|continue|next|get started|submit)$/i.test(c.name)) ?? [...here.controls].reverse().find(c => pressable(c) && SUBMIT.test(c.name) && c.name.length <= 30);
    if (!submit) throw await stop('unknown', `the sign-in form has no button the runner knows (${done.message})`, undefined, here);
    await click(submit.name);
    await sleep(800);
    await verifyEmail();
    // Still on a form with a password box: the site did not accept it (a required choice, a rejected address). The page says why.
    const after = await look();
    if (after.hasPassword && after.fields.length) throw await stop('unknown', 'the sign-up form was not accepted (it is still showing)', undefined, after);
  };

  /** A first sign-in often ends on a page that only wants the terms accepted: press it (nothing to type, nothing bought). */
  const completeRegistration = async (): Promise<void> => {
    for (let round = 0; round < 2; round++) {
      const v = await look();
      if (v.hasPassword || v.fields.length || !TERMS_NOTICE.test(v.text)) return;
      const go = v.controls.find(c => pressable(c) && !c.footer && COMPLETE_SIGNUP.test(c.name.trim()));
      if (!go || !(await click(go.name))) return;
      await sleep(900);
    }
  };

  /** Controls that mean sign-in, outside the footer, a provider's own link excluded: "Continue with Google" style first. */
  const providerButtons = (v: KeyView, re: RegExp): KeyControl[] => v.controls
    .filter(c => c.name.length <= 80 && (!c.leaf || providerRank(c) < 2) && !c.footer && re.test(c.name) && !(c.href && SOCIAL_HOST.test(hostOf(c.href))))
    .sort((a, b) => providerRank(a) - providerRank(b));
  const entryOf = (v: KeyView, re: RegExp): KeyControl | undefined => v.controls.find(c => pressable(c) && !c.footer && re.test(c.name.replace(/\s*last used\s*$/i, '').trim()));

  /** A "choose the product and sign in" page: the self-serve option, else a hand-off naming the options. */
  const choose = async (v: KeyView): Promise<boolean> => {
    const chooser = chooserOptions(v);
    if (!chooser) return false;
    if (!chooser.pick) throw await stop('choice', `the site asks which product to sign in to and none is plainly the API one: ${chooser.options.map(o => o.name).join(' | ').slice(0, 200)}`, undefined, v);
    if (!(await click(chooser.pick.name))) throw await stop('choice', `could not press the "${chooser.pick.name}" option (the others: ${chooser.options.filter(o => o !== chooser.pick).map(o => o.name).join(' | ').slice(0, 160)})`, undefined, v);
    await sleep(700);
    return true;
  };

  /** Sign in to the vendor from whatever sign-in or sign-up screen is showing. */
  let signedIn = options.resume?.signedIn === true;
  const authenticate = async (): Promise<void> => { await signIn(); signedIn = true; };
  const signIn = async (): Promise<void> => {
    authTries++;
    const pressed = new Set<string>(); // each entry once: "Get started" that only validates an email box is followed by "Log in"
    const fresh = (re: RegExp, page: KeyView): KeyControl | undefined => page.controls.find(c => pressable(c) && !c.footer && !pressed.has(c.name) && re.test(c.name.replace(/\s*last used\s*$/i, '').trim()));
    for (let attempt = 0; attempt < 4; attempt++) {
      const v = await look();
      if (await choose(v)) continue;
      // Each provider button is verified: the click must take the page to the provider or change it, else the next candidate is tried.
      for (const [name, re] of [['google', GOOGLE_BUTTON], ['github', GITHUB_BUTTON]] as const) {
        for (const button of providerButtons(v, re).slice(0, 3)) {
          if (!(await click(button.name))) continue;
          await sleep(700);
          const after = await port.look();
          if (!HOSTS_OF_SIGN_IN.test(hostOf(after.url)) && pathOf(after.url) === pathOf(v.url) && after.text === v.text) { say(`"${button.name}" did not go anywhere`); continue; }
          route = name;
          await providerScreens();
          await verifyEmail();
          await completeRegistration();
          return;
        }
      }
      if (v.hasPassword) { await emailRoute(v); return; }
      // A log-in or sign-up entry comes before an email box: a lone email box on a front page is a newsletter, not a sign-in form.
      const entry = fresh(SIGN_UP_ENTRY, v) ?? fresh(SIGN_IN_ENTRY, v) ?? fresh(SIGN_IN_LOOSE, v);
      if (!entry && v.fields.some(f => /e-?mail/i.test(f))) { await emailRoute(v); return; }
      // Nothing left to press and no sign-in screen showing: an entry already pressed signed us in (the vendor's session, or a provider's one-click login).
      if (!entry && pressed.size && !authWall(v) && !providerButtons(v, GOOGLE_BUTTON).length && !providerButtons(v, GITHUB_BUTTON).length) { say('signed in by the last press'); return; }
      if (!entry) break;
      pressed.add(entry.name);
      await click(entry.name);
      await sleep(600);
    }
    throw await stop('unknown', 'no way to sign in was found on the page');
  };

  let lastOpenError = '';
  const openAt = async (url: string): Promise<KeyView | undefined> => {
    const err = await act(`open ${pathOf(url).replace(/^https:\/\//, '')}`, () => port.open(url));
    if (err) { say(`could not open ${pathOf(url)}: ${err.slice(0, 160)}`); lastOpenError = err.slice(0, 200); return undefined; }
    return look();
  };

  let shown: KeyView = { url: '', text: '', controls: [], fields: [], hasPassword: false }; // the last page that was a real page, for the report if nothing is found
  /** Signed in: read the account and avatar menus, workspace switchers, settings pages, the site's search and the side navigation for a key page. */
  let exploredRuns = 0;
  const exploreSignedIn = async (v: KeyView): Promise<{ found?: KeyView; last: KeyView } | undefined> => {
    if (exploredRuns >= 2 || isKeyPage(v)) return undefined;
    const email = await port.profileEmail().catch(quiet('agent/computer/keygrab'));
    // Signed in: this run signed in, or the page looks like an app (an account menu or the signed-in address, no sign-in entry).
    const looksSignedIn = !offersSignIn(v) && menuOpeners(v, email).some(c => c.menu === true || (!!email && c.name.toLowerCase().includes(email.toLowerCase())));
    if (!((signedIn || looksSignedIn) && !authWall(v))) return undefined;
    exploredRuns++;
    const explored = await exploreForKeys({
      look, click, open: openAt, sleep, say,
      fill: (name, text) => act(`fill ${name}`, () => port.fill(name, text)),
      ...(port.press ? { press: (key: string) => act(`press ${key}`, () => port.press!(key)) } : {}),
      isKeyPage, needsSignIn: authWall,
    }, v, { maxPages: options.exploreMax ?? 8, ...(email ? { email } : {}), seen: visited, seenMenus: menus });
    visited.splice(0, visited.length, ...explored.visited);
    menus.splice(0, menus.length, ...explored.menus);
    for (const name of explored.tried) triedNames.add(name);
    shown = explored.last;
    return { ...(explored.found ? { found: explored.found } : {}), last: explored.last };
  };

  /** Walks to the API key page: menu items that read like one, then the common paths. Returns the view of the page that offers a key. */
  let homeUrl = '';
  const findKeyPage = async (start: KeyView): Promise<KeyView> => {
    let v = start;
    shown = start;
    if (isKeyPage(v)) return v;
    const explored = await exploreSignedIn(v);
    if (explored?.found) return explored.found;
    if (explored) { v = explored.last; shown = v; }
    const linksOf = (page: KeyView): KeyControl[] => [
      ...page.controls.filter(c => pressable(c) && !NEVER_KEY.test(c.name) && API_LINK.test(c.name)),
      ...page.controls.filter(c => pressable(c) && !NEVER_KEY.test(c.name) && !API_LINK.test(c.name) && API_LINK_AREA.test(c.name) && c.name.length <= 60),
      ...page.controls.filter(c => pressable(c) && !NEVER_KEY.test(c.name) && !API_LINK.test(c.name) && API_LINK_WEAK.test(c.name)),
    ].filter(c => !triedNames.has(c.name)).filter((c, i, all) => all.findIndex(o => o.name === c.name) === i).slice(0, 3);
    // The page we are on after signing in (an account area, a sign-in host) may have no API menu: the vendor's own front page does.
    const sources: Array<{ at?: string; page: KeyView }> = [{ page: v }];
    if (homeUrl && pathOf(homeUrl) !== pathOf(v.url)) sources.push({ at: homeUrl, page: v });
    for (const source of sources) {
      if (source.at) {
        const home = await openAt(source.at);
        if (!home) continue;
        if (isKeyPage(home)) return home;
        source.page = home;
        shown = home;
      }
      for (const link of linksOf(source.page)) {
        if (!(await click(link.name))) continue;
        await sleep(700);
        v = await look();
        if ((authWall(v) || (!isKeyPage(v) && signEntry(v))) && authTries < 2) { await authenticate(); v = await look(); const got = await exploreSignedIn(v); if (got?.found) return got.found; }
        if (isKeyPage(v)) return v;
        shown = v;
        // An API landing page names the way in ("Word Associations API Account"): follow the strong links on it, one level deeper.
        const deeper = v.controls.filter(c => pressable(c) && !c.footer && !NEVER_KEY.test(c.name) && c.name !== link.name && (API_LINK.test(c.name) || API_LINK_AREA.test(c.name)) && c.name.length <= 60).slice(0, 2);
        for (const next of deeper) {
          if (!(await click(next.name))) continue;
          await sleep(700);
          let w = await look();
          if ((authWall(w) || (!isKeyPage(w) && signEntry(w))) && authTries < 2) { await authenticate(); w = await look(); const got = await exploreSignedIn(w); if (got?.found) return got.found; }
          if (isKeyPage(w)) return w;
          shown = w;
          if (source.at) break;
          const back = await openAt(pathOf(v.url)); if (!back) break;
        }
        // The link led somewhere that is no key page: the next link starts from the same front page again.
        if (source.at && pathOf(v.url) !== pathOf(source.at)) { const back = await openAt(source.at); if (!back) break; }
      }
    }
    const origins = [...new Set([originOf(options.url), originOf(v.url)].filter(o => o && !HOSTS_OF_SIGN_IN.test(hostOf(o)) && !/^(?:auth|login|accounts|sso|idp|ui\.idp)\b/i.test(hostOf(o))))];
    for (const origin of origins) {
      for (const path of KEY_PATHS) {
        let page = await openAt(`${origin}${path}`);
        if (!page || NOT_FOUND.test(page.text.slice(0, 400))) continue;
        if (authWall(page) && authTries < 2) { await authenticate(); page = await openAt(`${origin}${path}`); if (!page) continue; const got = await exploreSignedIn(page); if (got?.found) return got.found; }
        if (isKeyPage(page)) return page;
        shown = page;
      }
    }
    // Leave the browser on the most useful page seen, not on the last guessed path (a 404): the tab is kept for a resumed run.
    if (pathOf(shown.url) && pathOf(shown.url) !== pathOf(await port.look().then(l => l.url).catch(() => ''))) { trail.push(`go back to ${pathOf(shown.url).replace(/^https:\/\//, '')}`); await port.open(shown.url).catch(quiet('agent/computer/keygrab')); }
    const gone = RETIRED.exec(start.text)?.[0];
    const human: HumanStep | undefined = gone ? { kind: 'retire', ...(pathOf(start.url).startsWith('https://') ? { url: pathOf(start.url) } : {}), reasonCode: 'vendor-retired', instructions: `${hostOf(start.url)} says "${gone.slice(0, 120)}" and has no API key page; confirm and retire the connector.` } : undefined;
    throw await stop('unknown', 'no API key page was found (menu links and the common paths were tried)', human, shown);
  };

  /** A key form that offers a role, scope, team or permission selector: choose the broadest on offer (the user's own test account), record each choice in the trail. */
  const chosen: string[] = [];
  const chooseBroadest = async (form: KeyView): Promise<KeyView> => {
    const done = new Set<string>();
    for (let round = 0; round < 6; round++) {
      const all = allAtOnce(form.controls, done);
      if (all && pressable(all)) {
        done.add(all.name);
        if (await click(all.name)) { chosen.push(all.name); say(`chose "${all.name}"`); await sleep(300); form = await look(); continue; }
      }
      const selector = selectorsOf(form.controls, done)[0];
      if (!selector) break;
      done.add(selector.name);
      const before = form.controls;
      if (!(await click(selector.name))) continue;
      await sleep(300);
      const opened = await look();
      const options = revealedOptions(before, opened.controls);
      const pick = broadestOption(options);
      if (!pick) { trail.push(`${selector.name}: no broad option among ${options.slice(0, 6).join(', ') || 'none'}; left as it is`.slice(0, 120)); form = opened; continue; }
      if (await click(pick)) { chosen.push(`${selector.name} -> ${pick}`); trail.push(`broadest for "${selector.name}": ${pick} (of ${options.slice(0, 6).join(', ')})`.slice(0, 120)); await sleep(300); }
      form = await look();
    }
    return form;
  };
  const captured = async (target?: string): Promise<{ ok: boolean; message: string }> => act('capture the key', () => port.capture(target));

  try {
    // Start where a web page answers: the address given, else the spec's other addresses and the vendor's usual ones, tested with a cheap fetch first.
    let startUrl = options.url;
    if (port.probe && !options.resume) {
      for (const candidate of startCandidates(options.url, options.alternates).slice(0, 14)) {
        const got = await port.probe(candidate).catch(quiet('agent/computer/keygrab'));
        if (got?.html && got.status !== 404 && got.status !== 410 && got.status < 500) { startUrl = got.url || candidate; break; }
      }
    }
    const first = options.resume ? await look() : await openAt(startUrl);
    if (!first) throw await stop('unknown', `could not open ${pathOf(startUrl)}${lastOpenError ? `: ${lastOpenError}` : ''}`);
    let v = first;
    homeUrl = options.resume ? startUrl : first.url;
    // An API host (no controls at all, a bare JSON error) is not the vendor's site: start from its parent domain.
    const labels = hostOf(v.url).split('.');
    if (!options.resume && !v.controls.length && !v.fields.length && labels.length > 2) {
      const apex = await openAt(`https://${labels.slice(1).join('.')}/`);
      if (apex) v = apex;
    }
    // A page that offers sign-in and no key controls (or asks which product to sign in to): sign in first, then look for the key page.
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
          dialog = await chooseBroadest(dialog);
          const confirm = [...dialog.controls].reverse().find(c => pressable(c) && CONFIRM.test(c.name) && !NEVER_KEY.test(c.name));
          if (confirm) { await click(confirm.name); await sleep(900); dialog = await look(); }
        }
        let got = await captured();
        if (!got.ok) {
          const reveal = revealOf(dialog);
          if (reveal) got = await captured(reveal.name);
        }
        if (got.ok) return { ok: true, note: `key created (named ClikDeploy${chosen.length ? `; broadest access chosen: ${chosen.join('; ')}` : ''}), captured unseen and sent to ClikDeploy`, steps, route };
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
