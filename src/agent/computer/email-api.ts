/**
 * Email through the Gmail API, so a sign-up that wants an emailed code or link needs neither a browser inbox nor the user.
 *
 * One consent in the ClikCode browser stores a refresh token in Secrets Manager (`email/gmail`); after that the
 * browser tool's read_email_code and open_email_link read mail through the API and return only the code or the link.
 * The token is read inside the worker and is never in a tool result.
 */
import { quiet } from '../../runtime/lifecycle-log.js';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { claimMessage, isClaimed } from './email-consumed.js';
import { vendorOf } from './parking.js';
import { profileEmail } from './profiles.js';
import { readNamedSecret, saveNamedSecret, deleteNamedSecret, CredentialError } from './credential-vault.js';

export const EMAIL_TOKEN_SECRET = 'email/gmail';
export const EMAIL_CLIENT_SECRET = 'email/google-client';
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

export interface GoogleEndpoints { auth: string; token: string; gmail: string }
export const GOOGLE: GoogleEndpoints = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  gmail: 'https://gmail.googleapis.com/gmail/v1/users/me',
};

interface Client { clientId: string; clientSecret: string }
interface Stored { refreshToken: string; email: string; connectedAt: string }
const cached = new Map<string, { token: string; expires: number }>();

/** The OAuth client this install asks consent with: the vault, else the environment. */
export async function emailClient(stateDir: string): Promise<Client> {
  try {
    const client = JSON.parse(await readNamedSecret(stateDir, EMAIL_CLIENT_SECRET)) as Partial<Client>;
    if (client.clientId && client.clientSecret) return { clientId: client.clientId, clientSecret: client.clientSecret };
  } catch { /* not saved as one JSON secret */ }
  try { // or as two secrets, the way capture_secret saves what a console shows once
    const clientId = await readNamedSecret(stateDir, `${EMAIL_CLIENT_SECRET}-id`), clientSecret = await readNamedSecret(stateDir, `${EMAIL_CLIENT_SECRET}-secret`);
    if (clientId && clientSecret) return { clientId, clientSecret };
  } catch { /* none saved */ }
  const clientId = process.env.CLIKCODE_GOOGLE_CLIENT_ID, clientSecret = process.env.CLIKCODE_GOOGLE_CLIENT_SECRET;
  if (clientId && clientSecret) return { clientId, clientSecret };
  throw new CredentialError(`No Google OAuth client is set up for email. Save a Desktop-app client as the secrets "${EMAIL_CLIENT_SECRET}-id" and "${EMAIL_CLIENT_SECRET}-secret" (or one JSON secret "${EMAIL_CLIENT_SECRET}") or set CLIKCODE_GOOGLE_CLIENT_ID and CLIKCODE_GOOGLE_CLIENT_SECRET.`);
}

async function stored(stateDir: string): Promise<Stored | undefined> {
  try { return JSON.parse(await readNamedSecret(stateDir, EMAIL_TOKEN_SECRET)) as Stored; } catch { return undefined; }
}
/** Is a mailbox connected, and which one. Never the token. */
export async function emailStatus(stateDir: string): Promise<{ connected: boolean; email?: string; connectedAt?: string }> {
  const s = await stored(stateDir);
  return s ? { connected: true, email: s.email, connectedAt: s.connectedAt } : { connected: false };
}
export async function emailConnected(stateDir: string): Promise<boolean> { return (await stored(stateDir)) !== undefined; }
export async function disconnectEmail(stateDir: string): Promise<boolean> {
  cached.delete(stateDir);
  return deleteNamedSecret(stateDir, EMAIL_TOKEN_SECRET);
}

const b64u = (bytes: Buffer): string => bytes.toString('base64url');

/** A one-time loopback listener for Google's redirect. `done` resolves with the authorization code once Google redirects back. */
export async function startConsent(stateDir: string, options: { loginHint?: string; endpoints?: GoogleEndpoints; timeoutMs?: number } = {}): Promise<{ url: string; done: Promise<{ email: string }>; cancel: () => void }> {
  const endpoints = options.endpoints ?? GOOGLE;
  const client = await emailClient(stateDir);
  const verifier = b64u(randomBytes(32));
  const challenge = b64u(createHash('sha256').update(verifier).digest());
  const state = b64u(randomBytes(16));
  let finish!: (value: { email: string }) => void, fail!: (error: Error) => void;
  const done = new Promise<{ email: string }>((resolve, reject) => { finish = resolve; fail = reject; });
  done.catch(quiet('agent/computer/email-api'));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
    const page = (text: string): void => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><title>ClikCode</title><body style="font:16px system-ui;margin:3rem">${text}</body>`); };
    const code = url.searchParams.get('code');
    if (url.searchParams.get('state') !== state || !code) {
      page('Email was not connected. You can close this tab.');
      fail(new Error(url.searchParams.get('error') ? `Google did not grant access (${url.searchParams.get('error')}).` : 'The redirect did not match this request.'));
      return;
    }
    exchange(stateDir, client, code, verifier, redirect(server), endpoints).then(email => { page('Email connected. You can close this tab.'); finish({ email }); },
      error => { page('Email was not connected. You can close this tab.'); fail(error as Error); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const timer = setTimeout(() => fail(new Error('Consent was not completed in time.')), options.timeoutMs ?? 180_000);
  timer.unref();
  const close = (): void => { clearTimeout(timer); server.close(); server.closeAllConnections?.(); };
  done.then(close, close);
  const params = new URLSearchParams({ client_id: client.clientId, redirect_uri: redirect(server), response_type: 'code', scope: GMAIL_SCOPE, access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256', ...(options.loginHint ? { login_hint: options.loginHint } : {}) });
  return { url: `${endpoints.auth}?${params}`, done, cancel: () => fail(new Error('Consent was cancelled.')) };
}
function redirect(server: http.Server): string { return `http://127.0.0.1:${(server.address() as { port: number }).port}/callback`; }

async function exchange(stateDir: string, client: Client, code: string, verifier: string, redirectUri: string, endpoints: GoogleEndpoints): Promise<string> {
  const res = await fetch(endpoints.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(20_000),
    body: new URLSearchParams({ code, client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier }) });
  const body = await res.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !body.access_token) throw new Error(`Google refused the code (${body.error ?? res.status}).`);
  if (!body.refresh_token) throw new Error('Google gave no refresh token; remove the app at myaccount.google.com/permissions and connect again.');
  const profile = await (await fetch(`${endpoints.gmail}/profile`, { headers: { authorization: `Bearer ${body.access_token}` }, signal: AbortSignal.timeout(20_000) })).json().catch(() => ({})) as { emailAddress?: string };
  const email = profile.emailAddress ?? '';
  // The connected mailbox is the profile email (that is where sign-up codes go). Consenting as some other account must not silently
  // replace it: workers share one mailbox, and the replacement left every later code unreadable.
  const wanted = (await profileEmail(stateDir).catch(quiet('agent/computer/email-api')))?.trim().toLowerCase();
  const current = (await stored(stateDir).catch(quiet('agent/computer/email-api')))?.email?.trim().toLowerCase();
  if (wanted && current === wanted && email.trim().toLowerCase() !== wanted) throw new Error(`The connected mailbox is ${wanted}, the profile email. This consent was for ${email}, so it was not saved. Sign in to ${wanted} in the browser and connect again, or change the profile email first.`);
  await saveNamedSecret(stateDir, EMAIL_TOKEN_SECRET, JSON.stringify({ refreshToken: body.refresh_token, email, connectedAt: new Date().toISOString() } satisfies Stored), { vendor: 'gmail', owner: email, env: 'oauth' });
  cached.set(stateDir, { token: body.access_token, expires: Date.now() + (body.expires_in ?? 3000) * 1000 - 60_000 });
  return email;
}

async function accessToken(stateDir: string, endpoints: GoogleEndpoints): Promise<string> {
  const hit = cached.get(stateDir);
  if (hit && hit.expires > Date.now()) return hit.token;
  const saved = await stored(stateDir);
  if (!saved) throw new CredentialError('No mailbox is connected. Run `clikcode computer email connect`, or the browser tool action email_connect.');
  const client = await emailClient(stateDir);
  const res = await fetch(endpoints.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(20_000),
    body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, refresh_token: saved.refreshToken, grant_type: 'refresh_token' }) });
  const body = await res.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !body.access_token) {
    if (body.error === 'invalid_grant') throw new CredentialError('Google no longer accepts the saved mailbox consent (an app still in testing mode expires it after 7 days). Reconnect with `clikcode computer email connect`.');
    throw new Error(`Google would not refresh the mailbox token (${body.error ?? res.status}).`);
  }
  cached.set(stateDir, { token: body.access_token, expires: Date.now() + (body.expires_in ?? 3000) * 1000 - 60_000 });
  return body.access_token;
}

export interface FoundEmail { id: string; from: string; subject: string; text: string; links: string[]; /** The same links with their text, for choosing among them. */ anchors?: MailAnchor[]; receivedAt: number }
export interface MailAnchor { href: string; text: string; button?: boolean; image?: boolean }
type Part = { mimeType?: string; body?: { data?: string }; parts?: Part[] };
const decode = (data?: string): string => (data ? Buffer.from(data, 'base64url').toString('utf8') : '');
function collect(part: Part | undefined, kind: string, out: string[] = []): string[] {
  if (!part) return out;
  if (part.mimeType === kind && part.body?.data) out.push(decode(part.body.data));
  for (const child of part.parts ?? []) collect(child, kind, out);
  return out;
}
function htmlToText(html: string): string {
  return html.replace(/<(?:style|script)[\s\S]*?<\/(?:style|script)>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}
function hrefs(html: string): string[] {
  return [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]!.replace(/&amp;/g, '&')).filter(href => /^https:/.test(href));
}

function anchors(html: string): MailAnchor[] {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].flatMap(m => {
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(m[1]!)?.[1]?.replace(/&amp;/g, '&');
    if (!href || !/^https:/.test(href)) return [];
    const text = htmlToText(m[2]!.replace(/<img\b[^>]*alt\s*=\s*["']([^"']*)["'][^>]*>/gi, ' $1 '));
    return [{ href, text, ...(/button|btn|padding\s*:\s*\d|border-radius|background(?:-color)?\s*:/i.test(m[1]!) ? { button: true } : {}), ...(/<img\b/i.test(m[2]!) && !htmlToText(m[2]!.replace(/<img\b[^>]*>/gi, '')) ? { image: true } : {}) }];
  });
}

export class EmailAmbiguous extends Error {}

/** Newsletters and promotions: never the wanted message, and not counted as "the email that arrived". */
export const MARKETING = /newsletter|webinar|new features|what'?s new|promo|% off|sale\b|digest|unsubscribe from (?:these|all)|view (?:this )?in (?:your )?browser/i;
export const isMarketing = (mail: Pick<FoundEmail, 'subject' | 'text'>): boolean => MARKETING.test(mail.subject) || MARKETING.test(mail.text.slice(0, 200));

/** The start of the body that names the vendor: 400 characters, or 1500 when `widen` (a lone email after the request, sent by an unrelated mail service). */
const BODY_START = 400;
const BODY_START_WIDE = 1500;

/** Does this email belong to `site`? Sender domain or display name, else the subject, else the start of the body. Returns the strongest tier (0 = no). */
export function senderMatch(mail: Pick<FoundEmail, 'from' | 'subject' | 'text'>, site: string, options: { widen?: boolean } = {}): { tier: 0 | 1 | 2 | 3; domain: string } {
  const name = vendorOf(site);
  const forms = [...new Set([name, name.replace(/-/g, ''), name.replace(/-/g, ' ')])].filter(form => form.length >= 3 && form !== 'unknown');
  const from = mail.from.toLowerCase();
  const domain = /@([^>\s]+)/.exec(from)?.[1] ?? '';
  const display = from.replace(/<.*$/, '');
  const flat = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const inDomain = forms.some(form => domain.replace(/[^a-z0-9]/g, '').includes(form.replace(/[^a-z0-9]/g, '')));
  if (inDomain || forms.some(form => flat(display).includes(flat(form)))) return { tier: 1, domain };
  if (forms.some(form => flat(mail.subject).includes(flat(form)))) return { tier: 2, domain };
  if (forms.some(form => flat(mail.text.slice(0, options.widen ? BODY_START_WIDE : BODY_START)).includes(flat(form)))) return { tier: 3, domain };
  return { tier: 0, domain };
}

/**
 * Waits for the newest email that matches, arrived after `since` (default: the last 15 minutes), and returns its text and
 * links. A match is `from` / `subject`, and for `site` the sender must belong to it (domain or name, then subject, then body).
 * `accept` says whether a message is the wanted one (it has a code); with `consume` the message is then taken for this waiter
 * alone, so a second agent never receives it. Two different senders that both fit are not guessed between: EmailAmbiguous.
 */
export async function waitForEmail(stateDir: string, query: { from?: string; subject?: string; site?: string; since?: number; timeoutMs?: number; pollMs?: number; spam?: boolean; consume?: boolean; accept?: (mail: FoundEmail) => boolean; endpoints?: GoogleEndpoints; signal?: AbortSignal }): Promise<FoundEmail> {
  if (!query.from && !query.subject && !query.site) throw new Error('Name the sender (from), words from the subject, or the site the email is for.');
  const endpoints = query.endpoints ?? GOOGLE;
  const since = query.since ?? Date.now() - 15 * 60_000;
  const q = [query.from ? `from:(${query.from})` : '', query.subject ? `subject:(${query.subject})` : '', `after:${Math.floor(since / 1000) - 1}`].filter(Boolean).join(' ');
  const deadline = Date.now() + (query.timeoutMs ?? 90_000);
  for (;;) {
    query.signal?.throwIfAborted();
    const token = await accessToken(stateDir, endpoints);
    const headers = { authorization: `Bearer ${token}` };
    const list = await fetch(`${endpoints.gmail}/messages?${new URLSearchParams({ q, maxResults: query.site ? '20' : '5', ...(query.spam ? { includeSpamTrash: 'true' } : {}) })}`, { headers, signal: AbortSignal.timeout(20_000) });
    if (!list.ok) throw new Error(`Gmail would not list messages (HTTP ${list.status}).`);
    const ids = ((await list.json()) as { messages?: { id: string }[] }).messages ?? [];
    let found: FoundEmail[] = [];
    for (const { id } of ids) {
      if (query.consume && await isClaimed(stateDir, id)) continue;
      const res = await fetch(`${endpoints.gmail}/messages/${id}?format=full`, { headers, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) continue;
      const message = await res.json() as { internalDate?: string; payload?: Part & { headers?: { name: string; value: string }[] } };
      const header = (name: string): string => message.payload?.headers?.find(h => h.name.toLowerCase() === name)?.value ?? '';
      const html = collect(message.payload, 'text/html').join('\n');
      const plain = collect(message.payload, 'text/plain').join('\n');
      found.push({ id, from: header('from'), subject: header('subject'), text: plain.trim() || htmlToText(html), links: hrefs(html || plain), anchors: anchors(html), receivedAt: Number(message.internalDate ?? 0) });
    }
    found = found.filter(mail => mail.receivedAt >= since && (!query.accept || query.accept(mail)));
    if (query.site) {
      // A vendor that sends through an unrelated mail service names itself only deeper in the body: look further
      // there when this is the only real (non-marketing) email that arrived since the request.
      const widen = found.filter(mail => !isMarketing(mail)).length === 1;
      const scored = found.map(mail => ({ mail, ...senderMatch(mail, query.site!, { widen }) })).filter(item => item.tier > 0);
      const best = Math.min(...scored.map(item => item.tier), 9);
      found = scored.filter(item => item.tier === best).map(item => item.mail);
      // Two different senders both fit this site: that is another agent's mail or a lookalike, and a guess here types a wrong code.
      const senders = new Set(found.map(mail => /@([^>\s]+)/.exec(mail.from.toLowerCase())?.[1] ?? mail.from));
      if (senders.size > 1) throw new EmailAmbiguous(`Emails from ${[...senders].slice(0, 3).join(' and ')} both fit ${vendorOf(query.site)}; not choosing between them.`);
    }
    // Newest first: a resend from the same sender replaces the older code.
    for (const mail of found.sort((a, b) => b.receivedAt - a.receivedAt)) {
      if (!query.consume || await claimMessage(stateDir, mail.id)) return mail;
    }
    if (Date.now() >= deadline) throw new Error(`No email matched ${query.site ? `an email for ${vendorOf(query.site)}` : q} within ${Math.round((query.timeoutMs ?? 90_000) / 1000)} seconds.`);
    await new Promise(resolve => setTimeout(resolve, query.pollMs ?? 3_000));
  }
}
