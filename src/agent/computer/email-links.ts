/**
 * Which link of a mail to open. The first real link is often the logo (the vendor's homepage), so every link is scored:
 * verify / confirm / sign-in words, a button-like anchor and a long opaque token score up; a logo image, the site root,
 * unsubscribe, privacy, terms and social links score down. Same mail, same pick, every time.
 */
export interface MailLink { href: string; text: string; /** The anchor is styled as a button, or holds only an image. */ button?: boolean; image?: boolean }

const WANTED = /verif|confirm|activat|validat|magic|login|log-in|sign-?in|token|code|reset|accept|invite/i;
const UNWANTED = /unsubscribe|accounts\.google\.com|mail\.google\.com|privacy|terms|preferences|manage[-_ ]?(?:email|subscri)|view[-_ ]?in[-_ ]?browser/i;
const SOCIAL = /(?:^|\.)(?:twitter|x|facebook|linkedin|instagram|youtube|tiktok|github|discord|medium)\.(?:com|gg)$/i;

function parse(href: string): URL | undefined { try { return new URL(href); } catch { return undefined; } }
const opaque = (s: string): boolean => /[A-Za-z0-9_-]{20,}/.test(s) && /\d/.test(s);

export function scoreLink(link: MailLink): number {
  const url = parse(link.href);
  if (!url) return -100;
  const text = link.text.trim();
  let score = 0;
  if (UNWANTED.test(link.href) || UNWANTED.test(text)) score -= 100;
  if (SOCIAL.test(url.hostname)) score -= 60;
  if (url.pathname.replace(/\/+$/, '') === '' && !url.search) score -= 50; // the homepage
  if (link.image) score -= 40; // a logo or banner picture
  if (WANTED.test(text)) score += 40;
  if (WANTED.test(url.pathname) || WANTED.test(url.search)) score += 30;
  if (link.button) score += 20;
  if (opaque(url.search) || opaque(url.pathname)) score += 20;
  if (url.search.length > 40) score += 10;
  return score;
}

export interface LinkPick { chosen: MailLink; others: string[] }

/** Best link (or, with a hint, the best link mentioning it), never one scored as unwanted. Order of the mail breaks ties. */
export function pickLink(links: MailLink[], hint?: string): LinkPick | undefined {
  const wanted = hint?.trim().toLowerCase();
  const ranked = links.map((link, index) => ({ link, index, score: scoreLink(link) }))
    .filter(entry => entry.score > -100)
    .filter(entry => !wanted || `${entry.link.href} ${entry.link.text}`.toLowerCase().includes(wanted))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const first = ranked[0];
  if (!first) return undefined;
  const seen = new Set([first.link.href]);
  const others = ranked.slice(1).filter(entry => !seen.has(entry.link.href) && seen.add(entry.link.href)).slice(0, 6).map(entry => entry.link.text.trim() || parse(entry.link.href)?.hostname || 'link');
  return { chosen: first.link, others };
}

/** Host and path only: the query or fragment of a mailed link is the token. */
export function describeLink(link: MailLink): string {
  const url = parse(link.href);
  return url ? `${url.hostname}${url.pathname.length > 40 ? `${url.pathname.slice(0, 40)}...` : url.pathname}` : 'a link';
}
