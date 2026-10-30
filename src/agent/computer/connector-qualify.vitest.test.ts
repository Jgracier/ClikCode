import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apiPlan, classify, hits, pickLinks, qualifyVendor, type PageRole, type QualifyPorts, type RenderedPage } from './connector-qualify.js';
import { SERVER_PHRASES } from './connector-qualify-phrases.js';
import { addressesFrom } from './connector-qualify-live.js';

const page = (role: PageRole, text: string, over: Partial<RenderedPage> = {}): RenderedPage => ({ role, url: `https://vendor.example/${role}`, status: 200, text, hasForm: false, hasEmailField: false, captchaWidget: false, ...over });
const form = { hasForm: true, hasEmailField: true };

describe('qualify classification', () => {
  it('a plain sign-up with a free key is auto', () => {
    const r = classify('v', [page('home', 'Time tracking for teams'), page('signup', 'Create your account\nEmail\nNo credit card required', form), page('docs', 'Get your API key in Settings > API.')]);
    expect(r).toMatchObject({ lane: 'auto', kinds: [] });
  });

  it('"no credit card required" is not a wall, "a credit card is required" is', () => {
    expect(classify('v', [page('signup', 'Start free. No credit card required.', form)]).kinds).toEqual([]);
    expect(classify('v', [page('signup', 'Start free, credit card not required.', form)]).kinds).toEqual([]);
    expect(classify('v', [page('signup', 'Try it first. A credit card is required, and you will not be charged until the trial ends.', form)]).kinds).toEqual(['card']);
  });

  it('a FAQ question about a card is not a wall', () => {
    expect(classify('v', [page('pricing', 'Is a credit card required to start the trial?\nNo, you can start right away.')]).kinds).toEqual([]);
  });

  it('a captcha counts on a form only, and an invisible reCAPTCHA notice is no wall', () => {
    expect(classify('v', [page('home', 'This site is protected by reCAPTCHA and the Google Privacy Policy apply.', form)]).kinds).toEqual([]);
    expect(classify('v', [page('signup', 'Join us. This site is protected by reCAPTCHA.', form)]).kinds).toEqual([]);
    expect(classify('v', [page('signup', 'Please confirm you are human to continue', form)]).kinds).toEqual(['captcha']);
    expect(classify('v', [page('signup', 'Create account', { ...form, captchaWidget: true })]).kinds).toEqual(['captcha']);
    expect(classify('v', [page('docs', 'Our captcha policy for the API')]).kinds).toEqual([]);
  });

  it('a phone code on sign-up is sms', () => {
    expect(classify('v', [page('signup', 'We will text you a code. Enter your phone number', form)]).kinds).toEqual(['sms']);
  });

  it('an API reserved for a paid plan is paid-plan; an upgrade to integrate is too', () => {
    expect(classify('v', [page('docs', 'API access is available on the Business plan only.')]).kinds).toContain('paid-plan');
    expect(classify('v', [page('pricing', 'To integrate your tools, upgrade to a paid plan.')]).kinds).toContain('paid-plan');
    expect(classify('v', [page('docs', 'The API is free for every account.')]).kinds).toEqual([]);
  });

  it('the API listed under a paid plan heading while a free plan exists is plan-gated; under the free plan it is not', () => {
    const gated = 'Free\n$0\nUnlimited mailings\nPlus\n$45\nAPI and Zapier integration\nPro\n$65\nSSO';
    expect(apiPlan(gated)).toBe('plus');
    expect(classify('v', [page('pricing', gated)]).kinds).toEqual(['paid-plan']);
    expect(apiPlan('Free\nAPI access\nPro\nSSO')).toBeUndefined();
    expect(apiPlan('Basic\nPro\nAPI access')).toBeUndefined();
    expect(apiPlan('Free\nPro\nAPI')).toBeUndefined();
  });

  it('enterprise-only API wording (also in Korean) is enterprise', () => {
    expect(classify('v', [page('docs', 'The API is only offered to Enterprise customers.')]).kinds).toContain('enterprise');
    expect(classify('v', [page('docs', 'API 는 엔터프라이즈 플랜을 사용하는 고객에게만 제공하고 있습니다.')]).kinds).toEqual(['enterprise']);
  });

  it('a sales or approval gate on the API is named, a demo button in the nav is not', () => {
    expect(classify('v', [page('docs', 'To get API access please contact sales.')]).kinds).toContain('sales');
    expect(classify('v', [page('home', 'Product\nPricing\nBook a demo\nWe build great software')]).kinds).toEqual([]);
    expect(classify('v', [page('docs', 'API access requires approval. Apply for access below.')]).kinds).toContain('approval');
  });

  it('work-email and free-mail rejection are named; a field label alone is only a hint', () => {
    expect(classify('v', [page('signup', 'Please use your work email to sign up', form)]).kinds).toEqual(['work-email']);
    expect(classify('v', [page('signup', 'Gmail and Yahoo addresses are not accepted.', form)]).kinds).toEqual(['free-mail']);
    const label = classify('v', [page('signup', 'Work email\nPassword', form)]);
    expect(label.kinds).toEqual([]);
    expect(label.hints?.[0]).toMatch(/work-email field label/);
  });

  it('slack-only: sign-in with Slack and no email field, or onboarding that connects a Slack workspace', () => {
    expect(classify('v', [page('signup', 'Continue with Slack', { hasForm: true, hasEmailField: false })]).kinds).toEqual(['slack-only']);
    expect(classify('v', [page('signup', 'Continue with Slack\nor use your email', form)]).kinds).toEqual([]);
    expect(classify('v', [page('docs', 'Installing: Connect your Slack workspace and get up and running in minutes.')]).kinds).toEqual(['slack-only']);
  });

  it('no-api wording makes the lane dead; a page that cannot load, everywhere, is a dead host', () => {
    expect(classify('v', [page('docs', 'Unfortunately we do not offer an API.')])).toMatchObject({ lane: 'dead', kinds: ['no-api'] });
    const dead = classify('v', [page('home', '', { error: 'net::ERR_NAME_NOT_RESOLVED', status: undefined })]);
    expect(dead).toMatchObject({ lane: 'dead', kinds: ['dead-host'] });
  });

  it('a card wall with prices and no free plan adds paid-plan', () => {
    const r = classify('v', [page('signup', 'A card is required to start the trial.', form), page('pricing', 'Pro $40 / person / mo\nTeam $425 / mo')]);
    expect(r.kinds).toEqual(['card', 'paid-plan']);
    expect(r.lane).toBe('human');
  });

  it('evidence carries the kind, the phrase and the url', () => {
    const r = classify('v', [page('docs', 'To get API access please contact sales.')]);
    expect(r.evidence[0]).toMatchObject({ kind: 'sales', url: 'https://vendor.example/docs' });
    expect(r.evidence[0]!.phrase).toContain('contact sales');
  });

  it('hits drops a phrase with a negation beside it', () => {
    expect(hits('no credit card required', ['card required'])).toEqual([]);
    expect(hits('credit card required', ['card required'])).toHaveLength(1);
  });
});

describe('qualify flow', () => {
  const ports = (pages: Record<string, RenderedPage>, log: string[]): QualifyPorts => ({
    discover: async () => ({ homepage: 'https://vendor.example/', signupUrl: 'https://vendor.example/signup' }),
    render: async (_id, role, url) => { log.push(`render ${role} ${url}`); return pages[url] ?? { role, url, text: '', hasForm: false, hasEmailField: false, captchaWidget: false, error: 'not found' }; },
    close: async id => { log.push(`close ${id}`); },
  });

  it('follows the home page links to pricing and docs, renders each once, and closes the vendor tab', async () => {
    const log: string[] = [];
    const home = page('home', 'Home', { links: [{ href: 'https://vendor.example/pricing', text: 'Pricing' }, { href: 'https://developers.vendor.example/', text: 'Developers' }, { href: 'https://vendor.example/signup', text: 'Sign up' }] });
    const r = await qualifyVendor('v', ports({ 'https://vendor.example/': home, 'https://vendor.example/signup': page('signup', 'Create account', form), 'https://vendor.example/pricing': page('pricing', 'Free $0'), 'https://developers.vendor.example/': page('docs', 'Create a key.') }, log));
    expect(r.lane).toBe('auto');
    expect(log.filter(l => l.startsWith('render')).map(l => l.split(' ')[1])).toEqual(['home', 'signup', 'pricing', 'docs']);
    expect(log.at(-1)).toBe('close v');
  });

  it('picks links by their words', () => {
    expect(pickLinks(page('home', '', { links: [{ href: 'https://a.example/docs', text: 'Documentation' }, { href: 'https://a.example/get-started', text: 'Get started free' }, { href: 'https://a.example/plans', text: 'Pricing' }] }))).toEqual({ signup: 'https://a.example/get-started', pricing: 'https://a.example/plans', docs: 'https://a.example/docs' });
  });

  it('reads the pages out of a connector_discover answer', () => {
    expect(addressesFrom({ signup: { url: 'https://a.example/signup' }, evidence: [{ purpose: 'signup page', url: 'https://a.example/' }, { purpose: 'pricing link', url: 'https://a.example/pricing' }] })).toEqual({ homepage: 'https://a.example/', signupUrl: 'https://a.example/signup', pricingUrl: 'https://a.example/pricing' });
  });
});

describe('the phrase lists', () => {
  const server = ['../clikdeploy', '../../clikdeploy', '/home/justin-gracier/projects/clikdeploy'].map(d => new URL(d, `file://${process.cwd()}/`).pathname).concat('/home/justin-gracier/projects/clikdeploy')
    .map(d => `${d}/packages/platform-domains/src/domains/connectors/connector-pipeline-front-config.ts`).find(existsSync);
  it.skipIf(!server)('copy the server\'s discover and triage lists (connector-pipeline-front-config.ts)', () => {
    const source = readFileSync(server!, 'utf8');
    const listOf = (block: string, name: string): string[] => {
      const from = source.indexOf(`${block}: {\n    maxFetches`, source.indexOf('DEFAULT_FRONT_CONFIG'));
      const m = new RegExp(`${name}: \\[([^\\]]*)\\]`).exec(source.slice(from));
      return [...(m?.[1] ?? '').matchAll(/'([^']+)'/g)].map(x => x[1]!);
    };
    expect([...SERVER_PHRASES.captcha]).toEqual(listOf('discover', 'captchaPhrases'));
    expect([...SERVER_PHRASES.phone]).toEqual(listOf('discover', 'phonePhrases'));
    expect([...SERVER_PHRASES.card]).toEqual(listOf('discover', 'cardPhrases'));
    expect([...SERVER_PHRASES.sales]).toEqual(listOf('discover', 'salesPhrases'));
    expect([...SERVER_PHRASES.appReview]).toEqual(listOf('triage', 'appReviewPhrases'));
  });
});
