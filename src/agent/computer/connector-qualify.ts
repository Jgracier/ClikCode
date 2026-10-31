/** `clikcode connectors qualify`: decide from the RENDERED sign-up, pricing and developer pages whether a vendor's API key can be got with no person
 * (lane auto), needs one (human) or cannot be had (dead). Pure classification here; the browser and ClikDeploy are ports (connector-qualify-live.ts). */
import { EXTRA_PHRASES, ENTERPRISE_API, GATED_BY_PLAN, INTEGRATE_UPGRADE, NEGATION_AFTER, NEGATION_BEFORE, PLAN_HEADING, SERVER_PHRASES, SLACK_ONBOARDING } from './connector-qualify-phrases.js';

export type QualifyKind = 'captcha' | 'sms' | 'card' | 'paid-plan' | 'sales' | 'enterprise' | 'work-email' | 'free-mail' | 'slack-only' | 'approval' | 'no-api' | 'dead-host';
export type Lane = 'auto' | 'human' | 'dead';
export type PageRole = 'home' | 'signup' | 'pricing' | 'docs';
export interface RenderedPage {
  role: PageRole; url: string; status?: number; text: string;
  /** A sign-up style form is on the page (an email, password or phone field). */ hasForm: boolean;
  /** A field takes an email address. */ hasEmailField: boolean;
  /** A visible captcha challenge widget (not an invisible score badge). */ captchaWidget: boolean;
  links?: Array<{ href: string; text: string }>;
  /** The page could not be loaded: the reason. */ error?: string;
}
export interface QualifyEvidence { kind: QualifyKind; phrase: string; url: string }
export interface QualifyResult { id: string; lane: Lane; kinds: QualifyKind[]; evidence: QualifyEvidence[]; /** Things seen that are not walls. */ hints?: string[]; pages: Array<{ role: PageRole; url: string; ok: boolean; error?: string }> }

const norm = (text: string): string => text.toLowerCase().replace(/[‘’]/g, "'").replace(/[ \t\r\f\v ]+/g, ' ');

/** Every place `phrase` stands in `text` that no negation sits next to. */
export function hits(text: string, phrases: readonly string[], options: { negation?: boolean } = {}): Array<{ phrase: string; at: number }> {
  const out: Array<{ phrase: string; at: number }> = [];
  for (const phrase of phrases) {
    for (let from = 0; ;) {
      const at = text.indexOf(phrase, from);
      if (at < 0) break;
      from = at + phrase.length;
      if (options.negation !== false && (/^[^.\n!]{0,80}\?/.test(text.slice(at + phrase.length, at + phrase.length + 90)) || NEGATION_BEFORE.test(text.slice(Math.max(0, at - 48), at)) || NEGATION_AFTER.test(text.slice(at + phrase.length, at + phrase.length + 36)))) continue;
      out.push({ phrase, at });
    }
  }
  out.sort((a, b) => a.at - b.at);
  return out.filter((h, i) => i === 0 || h.at - out[i - 1]!.at > 25);
}

const lines = (text: string): string[] => text.split(/\n+|(?<=[.!?])\s+/).map(l => l.trim()).filter(l => l.length > 3 && l.length < 400);
const API_WORDS = /\bapi\b|\bapis\b|developer|integration|access token|api key/;
const PROTECTED_NOTICE = /protected by|privacy policy|terms of service|this site is|google privacy|protects? (?:this|our)/;
const FREE_MAIL_REJECTED = /(?:gmail|yahoo|hotmail|outlook|free email|personal email)[^.\n]{0,70}(?:not|aren'?t|isn'?t|cannot|can'?t|won'?t)[^.\n]{0,24}(?:accept|allow|support|valid|permit|work)|(?:no|not|don'?t|cannot|can'?t)[^.\n]{0,24}(?:accept|allow|support|use)[^.\n]{0,24}(?:gmail|yahoo|hotmail|personal email|free email)/;

/** The plan a short "API" feature line stands under on a pricing page, when none of the API lines stands under the free plan. */
export function apiPlan(text: string): string | undefined {
  let current = '', sawFree = false;
  const found: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (PLAN_HEADING.test(line)) { current = line.toLowerCase().replace(/ plan$/, ''); if (current === 'free') sawFree = true; continue; }
    if (line.length < 70 && line.toLowerCase() !== 'api' && /\bapi\b/i.test(line) && !/^(?:no|without)\b/i.test(line) && current) found.push(current);
  }
  if (!sawFree || !found.length || found.includes('free')) return undefined;
  return found[0];
}

export function classify(id: string, pages: RenderedPage[]): QualifyResult {
  const evidence: QualifyEvidence[] = [];
  const hints: string[] = [];
  const add = (kind: QualifyKind, phrase: string, url: string): void => {
    if (evidence.filter(e => e.kind === kind).length < 3 && !evidence.some(e => e.kind === kind && e.phrase === phrase && e.url === url)) evidence.push({ kind, phrase: phrase.slice(0, 160), url });
  };
  const loaded = pages.filter(p => !p.error && (p.status === undefined || p.status < 400) && p.text.trim().length > 0);
  if (pages.length && !loaded.some(p => p.role === 'home' || p.role === 'signup' || p.role === 'docs' || p.role === 'pricing')) {
    const first = pages.find(p => p.error) ?? pages[0]!;
    add('dead-host', first.error ?? `status ${first.status ?? 'none'}`, first.url);
  }
  for (const page of loaded) {
    const text = norm(page.text);
    const signupLike = page.role === 'signup' || page.role === 'home' && page.hasForm;
    const api = (re: RegExp): Array<{ line: string }> => lines(text).filter(l => re.test(l)).map(line => ({ line }));

    // A captcha counts on a form only; a footer saying "protected by reCAPTCHA" is an invisible score badge, not a challenge.
    if (page.hasForm && page.role !== 'docs' && page.role !== 'pricing') {
      if (page.captchaWidget) add('captcha', 'visible captcha widget', page.url);
      else for (const h of hits(text, [...SERVER_PHRASES.captcha, ...EXTRA_PHRASES.captcha])) {
        if (!PROTECTED_NOTICE.test(text.slice(Math.max(0, h.at - 70), h.at + h.phrase.length + 90))) add('captcha', h.phrase, page.url);
      }
    }
    if (signupLike || page.role === 'pricing') {
      for (const h of hits(text, [...SERVER_PHRASES.card, ...EXTRA_PHRASES.card])) add('card', text.slice(Math.max(0, h.at - 20), h.at + h.phrase.length + 20).trim(), page.url);
    }
    if (signupLike) {
      for (const h of hits(text, [...SERVER_PHRASES.phone, ...EXTRA_PHRASES.phone])) add('sms', h.phrase, page.url);
      for (const h of hits(text, EXTRA_PHRASES.workEmail)) add('work-email', h.phrase, page.url);
      const rejected = FREE_MAIL_REJECTED.exec(text);
      if (rejected) add('free-mail', rejected[0].slice(0, 120), page.url);
      for (const h of hits(text, EXTRA_PHRASES.freeMail.filter(p => p !== 'gmail' && p !== 'free email'))) add('free-mail', h.phrase, page.url);
      const slack = hits(text, EXTRA_PHRASES.slack, { negation: false });
      if (slack.length && !page.hasEmailField) add('slack-only', slack[0]!.phrase, page.url);
    }
    if (signupLike || page.role === 'docs') {
      const onboarding = SLACK_ONBOARDING.exec(text);
      if (onboarding) add('slack-only', onboarding[0], page.url);
    }
    if (page.role === 'docs' || page.role === 'pricing' || page.role === 'home') {
      for (const { line } of api(GATED_BY_PLAN)) add('paid-plan', line, page.url);
      for (const { line } of api(INTEGRATE_UPGRADE)) add('paid-plan', line, page.url);
      if (page.role === 'pricing') { const under = apiPlan(text); if (under) add('paid-plan', `the API is listed under the ${under} plan, not the free one`, page.url); }
      for (const { line } of api(ENTERPRISE_API)) if ((page.role === 'docs' || /only|plan|customers|contact|available|exclusive|reserved|tier|custom/.test(line)) ) add('enterprise', line, page.url);
      for (const { line } of api(API_WORDS)) {
        if (hits(line, SERVER_PHRASES.sales).length) add('sales', line, page.url);
        if (hits(line, [...SERVER_PHRASES.appReview, ...EXTRA_PHRASES.approval]).length) add('approval', line, page.url);
      }
    }
    // A field called "Work email" is a label, not a rejection of other addresses: shown, but it does not make a wall.
    if (page.hasForm && EXTRA_PHRASES.workEmailLabel.some(l => text.includes(l))) hints.push(`a work-email field label on ${page.url}`);
    for (const h of hits(text, EXTRA_PHRASES.noApi)) add('no-api', h.phrase, page.url);
  }
  // A card wall and a pricing page with prices but no free plan: the key costs money after the trial.
  const priced = loaded.find(p => p.role === 'pricing' && /[$€£]\s?\d/.test(p.text) && !/\bfree (?:plan|forever|tier)\b|\bforever free\b|use free plan|[$€£]\s?0\b/i.test(p.text));
  if (priced && evidence.some(e => e.kind === 'card')) add('paid-plan', 'a card is asked for, and the pricing page has prices and no free plan', priced.url);
  const kinds = [...new Set(evidence.map(e => e.kind))];
  const lane: Lane = kinds.includes('dead-host') || kinds.includes('no-api') ? 'dead' : kinds.length ? 'human' : 'auto';
  return { id, lane, kinds, evidence, ...(hints.length ? { hints: [...new Set(hints)] } : {}), pages: pages.map(p => ({ role: p.role, url: p.url, ok: !p.error && (p.status === undefined || p.status < 400) && p.text.trim().length > 0, ...(p.error ? { error: p.error.slice(0, 120) } : {}) })) };
}

/** Where to look, from the home page's own links. */
export function pickLinks(home: RenderedPage): { signup?: string; pricing?: string; docs?: string } {
  const links = home.links ?? [];
  const find = (words: RegExp, hrefWords?: RegExp): string | undefined => {
    const scored = links.map(l => ({ l, s: (words.test(l.text.toLowerCase()) ? 2 : 0) + (hrefWords?.test(l.href.toLowerCase()) ? 1 : 0) })).filter(x => x.s > 0 && /^https?:/i.test(x.l.href)).sort((a, b) => b.s - a.s);
    return scored[0]?.l.href;
  };
  return {
    signup: find(/^(?:sign ?up|get started(?: for free)?|start (?:for )?free|try (?:it )?free|create (?:an )?account|start free trial|free trial)\b/, /sign-?up|register|get-?started|trial/),
    pricing: find(/^pricing\b|^plans\b/, /pricing|plans/),
    docs: find(/^(?:developers?|api(?: docs| reference)?|documentation|docs|developer docs)\b/, /developers?\.|\/developers?|\/api|docs\./),
  };
}

export interface QualifyPorts {
  /** What ClikDeploy knows of the vendor's pages (connector_discover). */
  discover(id: string): Promise<{ homepage?: string; signupUrl?: string; pricingUrl?: string; docsUrl?: string }>;
  /** Render one address in the vendor's own named tab within the page budget; never throws. */
  render(id: string, role: PageRole, url: string): Promise<RenderedPage>;
  close(id: string): Promise<void>;
}

export async function qualifyVendor(id: string, ports: QualifyPorts): Promise<QualifyResult> {
  try {
    const known = await ports.discover(id).catch(() => ({}) as Awaited<ReturnType<QualifyPorts['discover']>>);
    const pages: RenderedPage[] = [];
    const seen = new Set<string>();
    const visit = async (role: PageRole, url: string | undefined): Promise<RenderedPage | undefined> => {
      if (!url) return undefined;
      const key = url.replace(/#.*$/, '').replace(/\/$/, '');
      if (seen.has(key)) return undefined;
      seen.add(key);
      const page = await ports.render(id, role, url);
      pages.push(page);
      return page;
    };
    const home = await visit('home', known.homepage ?? known.signupUrl);
    const found = home ? pickLinks(home) : {};
    await visit('signup', known.signupUrl ?? found.signup);
    if (found.signup) await visit('signup', found.signup);
    await visit('pricing', known.pricingUrl ?? found.pricing);
    await visit('docs', known.docsUrl ?? found.docs);
    if (!pages.length) return { id, lane: 'auto', kinds: [], evidence: [], hints: ['Qualification unavailable: no website address was found. Research the vendor before attempting signup.'], pages: [] };
    return classify(id, pages);
  } finally { await ports.close(id).catch(() => undefined); }
}

/** The typed wall (the loop's kinds) for a qualify kind, and the human step a person would take. */
const QUALIFY_WALL: Partial<Record<QualifyKind, { wall: string; kind: 'captcha' | 'sms' | 'payment' | 'vendor-contact' | 'app-review' | 'decision' | 'retire'; say: string }>> = {
  captcha: { wall: 'captcha', kind: 'captcha', say: 'the sign-up form has a captcha' },
  sms: { wall: 'sms', kind: 'sms', say: 'sign-up wants a phone code' },
  card: { wall: 'card', kind: 'payment', say: 'sign-up asks for a card' },
  'paid-plan': { wall: 'paid-plan', kind: 'payment', say: 'the API is gated by a paid plan' },
  sales: { wall: 'sales', kind: 'vendor-contact', say: 'API access is sold through sales' },
  enterprise: { wall: 'sales', kind: 'vendor-contact', say: 'the API is for enterprise customers' },
  approval: { wall: 'app-review', kind: 'app-review', say: 'API access needs the vendor\'s approval' },
  'work-email': { wall: 'work-email', kind: 'decision', say: 'sign-up wants a work email' },
  'free-mail': { wall: 'free-mail', kind: 'decision', say: 'sign-up rejects free-mail addresses' },
  'no-api': { wall: 'no-api', kind: 'retire', say: 'the vendor has no public API' },
  'dead-host': { wall: 'dead-host', kind: 'retire', say: 'the vendor\'s site does not load' },
};
export function humanStepForQualify(r: QualifyResult): { kind: 'captcha' | 'sms' | 'payment' | 'vendor-contact' | 'app-review' | 'decision' | 'retire'; url?: string; instructions: string; reasonCode: string } | undefined {
  const order: QualifyKind[] = ['dead-host', 'no-api', 'captcha', 'sms', 'card', 'paid-plan', 'sales', 'enterprise', 'approval', 'work-email', 'free-mail'];
  const kind = order.find(k => r.kinds.includes(k));
  const w = kind ? QUALIFY_WALL[kind] : undefined;
  if (!kind || !w) return undefined;
  const e = r.evidence.find(x => x.kind === kind);
  return { kind: w.kind, ...(e?.url && /^https:/.test(e.url) ? { url: e.url.split('#')[0]!.split('?')[0]! } : {}), instructions: `${w.say} (rendered page says: "${(e?.phrase ?? '').slice(0, 120)}").`, reasonCode: w.wall };
}
