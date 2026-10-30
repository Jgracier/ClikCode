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
import { readNamedSecret, saveNamedSecret, deleteNamedSecret, namedSecretNames, savedLoginsForSite, CredentialError } from './credential-vault.js';

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
// `cacheKey` below keys it by state directory and address.

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

const norm = (address: string): string => address.trim().toLowerCase();
const MAILBOX_PREFIX = 'email/gmail/';
/** The secret one mailbox is kept under: names allow no "@", so the address is spelled safely, and hashed when it would not fit. */
export function mailboxSecretName(address: string): string {
  const slug = norm(address).replace(/[^a-z0-9._-]/g, '_');
  return `${MAILBOX_PREFIX}${slug.length <= 40 ? slug : createHash('sha256').update(norm(address)).digest('hex').slice(0, 40)}`;
}

async function readStored(stateDir: string, name: string): Promise<Stored | undefined> {
  try { const s = JSON.parse(await readNamedSecret(stateDir, name)) as Stored; return s.refreshToken && s.email ? s : undefined; } catch { return undefined; }
}
async function saveStored(stateDir: string, s: Stored): Promise<void> {
  await saveNamedSecret(stateDir, mailboxSecretName(s.email), JSON.stringify(s), { vendor: 'gmail', owner: s.email, env: 'oauth' });
}

/** The single-mailbox record of before (`email/gmail`) becomes one entry of the new shape, once. */
async function migrateLegacy(stateDir: string): Promise<void> {
  const old = await readStored(stateDir, EMAIL_TOKEN_SECRET);
  if (!old) return;
  if (!(await readStored(stateDir, mailboxSecretName(old.email)))) await saveStored(stateDir, old);
  await deleteNamedSecret(stateDir, EMAIL_TOKEN_SECRET).catch(quiet('agent/computer/email-api'));
}

/** Every connected mailbox, in a stable order. */
async function allStored(stateDir: string): Promise<Stored[]> {
  await migrateLegacy(stateDir);
  const names = (await namedSecretNames(stateDir).catch(() => [] as string[])).filter(name => name.toLowerCase().startsWith(MAILBOX_PREFIX));
  const out: Stored[] = [];
  for (const name of names) { const s = await readStored(stateDir, name); if (s) out.push(s); }
  return out.sort((a, b) => a.email.localeCompare(b.email));
}

/** The mailbox used when nothing says otherwise: the profile email when it is connected, else the first. */
async function defaultStored(stateDir: string, all: Stored[]): Promise<Stored | undefined> {
  const mine = (await profileEmail(stateDir).catch(quiet('agent/computer/email-api')))?.trim().toLowerCase();
  return all.find(s => norm(s.email) === mine) ?? all[0];
}

export interface Mailbox { email: string; connectedAt: string; default: boolean }
/** Which mailboxes are connected (never a token). `email` / `connectedAt` are those of the default one. */
export async function emailStatus(stateDir: string): Promise<{ connected: boolean; email?: string; connectedAt?: string; mailboxes: Mailbox[] }> {
  const all = await allStored(stateDir);
  const def = await defaultStored(stateDir, all);
  if (!def) return { connected: false, mailboxes: [] };
  return { connected: true, email: def.email, connectedAt: def.connectedAt, mailboxes: all.map(s => ({ email: s.email, connectedAt: s.connectedAt, default: s === def })) };
}
/** Is any mailbox connected, or this address. */
export async function emailConnected(stateDir: string, address?: string): Promise<boolean> {
  const all = await allStored(stateDir);
  return address ? all.some(s => norm(s.email) === norm(address)) : all.length > 0;
}
/** Forgets one mailbox, or with no address every one. True when something was removed. */
export async function disconnectEmail(stateDir: string, address?: string): Promise<boolean> {
  const all = await allStored(stateDir);
  let removed = false;
  for (const s of all.filter(item => !address || norm(item.email) === norm(address))) {
    cached.delete(cacheKey(stateDir, s.email));
    removed = await deleteNamedSecret(stateDir, mailboxSecretName(s.email)) || removed;
  }
  return removed;
}
const cacheKey = (stateDir: string, address: string): string => `${stateDir}\0${norm(address)}`;

/**
 * Which mailbox a page's email goes to: the one asked for (error if it is not connected), else the first of `hints`
 * (the address typed into the page, the saved logins of the site) that is connected, else the default.
 */
export async function pickMailbox(stateDir: string, options: { address?: string; hints?: readonly (string | undefined)[] } = {}): Promise<string> {
  const all = await allStored(stateDir);
  if (options.address) {
    const hit = all.find(s => norm(s.email) === norm(options.address!));
    if (!hit) throw new CredentialError(`${options.address} is not a connected mailbox.${all.length ? ` Connected: ${all.map(s => s.email).join(', ')}.` : ''} Connect it with email_connect (address), or \`clikcode computer email connect --address ${options.address}\`.`);
    return hit.email;
  }
  for (const hint of options.hints ?? []) { const hit = hint && all.find(s => norm(s.email) === norm(hint)); if (hit) return hit.email; }
  const def = await defaultStored(stateDir, all);
  if (!def) throw new CredentialError('No mailbox is connected. Run `clikcode computer email connect`, or the browser tool action email_connect.');
  return def.email;
}

/** The addresses the saved logins of a site were made with, as hints for pickMailbox. */
export async function loginAddresses(stateDir: string, site: string): Promise<string[]> {
  try { return (await savedLoginsForSite(stateDir, site)).filter(login => !login.rejected).map(login => login.label); } catch { return []; }
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
  if (!email) throw new Error('Google did not say which account this consent was for, so it was not saved.');
  // A consent adds its mailbox (or renews that same address); it never replaces another connected mailbox.
  await saveStored(stateDir, { refreshToken: body.refresh_token, email, connectedAt: new Date().toISOString() });
  cached.set(cacheKey(stateDir, email), { token: body.access_token, expires: Date.now() + (body.expires_in ?? 3000) * 1000 - 60_000 });
  return email;
}

async function accessToken(stateDir: string, endpoints: GoogleEndpoints, address?: string): Promise<string> {
  const email = await pickMailbox(stateDir, { address });
  const hit = cached.get(cacheKey(stateDir, email));
  if (hit && hit.expires > Date.now()) return hit.token;
  const saved = (await allStored(stateDir)).find(s => norm(s.email) === norm(email))!;
  const client = await emailClient(stateDir);
  const res = await fetch(endpoints.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(20_000),
    body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, refresh_token: saved.refreshToken, grant_type: 'refresh_token' }) });
  const body = await res.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !body.access_token) {
    if (body.error === 'invalid_grant') throw new CredentialError(`Google no longer accepts the saved consent for ${saved.email} (an app still in testing mode expires it after 7 days). Reconnect with \`clikcode computer email connect --address ${saved.email}\`.`);
    throw new Error(`Google would not refresh the mailbox token (${body.error ?? res.status}).`);
  }
  cached.set(cacheKey(stateDir, saved.email), { token: body.access_token, expires: Date.now() + (body.expires_in ?? 3000) * 1000 - 60_000 });
  return body.access_token;
}

export interface FoundEmail { id: string; from: string; subject: string; text: string; links: string[]; /** The same links with their text, for choosing among them. */ anchors?: MailAnchor[]; receivedAt: number; /** The mailbox it was found in. */ mailbox?: string }
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
export async function waitForEmail(stateDir: string, query: { address?: string; from?: string; subject?: string; site?: string; since?: number; timeoutMs?: number; pollMs?: number; spam?: boolean; consume?: boolean; accept?: (mail: FoundEmail) => boolean; endpoints?: GoogleEndpoints; signal?: AbortSignal }): Promise<FoundEmail> {
  if (!query.from && !query.subject && !query.site) throw new Error('Name the sender (from), words from the subject, or the site the email is for.');
  const address = await pickMailbox(stateDir, { address: query.address });
  const endpoints = query.endpoints ?? GOOGLE;
  const since = query.since ?? Date.now() - 15 * 60_000;
  const q = [query.from ? `from:(${query.from})` : '', query.subject ? `subject:(${query.subject})` : '', `after:${Math.floor(since / 1000) - 1}`].filter(Boolean).join(' ');
  const deadline = Date.now() + (query.timeoutMs ?? 90_000);
  for (;;) {
    query.signal?.throwIfAborted();
    const token = await accessToken(stateDir, endpoints, address);
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
      found.push({ id, from: header('from'), subject: header('subject'), text: plain.trim() || htmlToText(html), links: hrefs(html || plain), anchors: anchors(html), receivedAt: Number(message.internalDate ?? 0), mailbox: address });
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

/** How long the chosen mailbox is waited on alone before the other connected mailboxes are tried too. */
export const OWN_MAILBOX_MS = 20_000;

/**
 * waitForEmail across mailboxes. The mailbox is the one asked for (`address`), else the first of `hints` that is connected, else the
 * default. When it has no match after OWN_MAILBOX_MS and other mailboxes are connected (and no address was demanded), they are
 * searched as well until the deadline. The mail says which mailbox it came from.
 */
export async function findEmail(stateDir: string, query: Parameters<typeof waitForEmail>[1] & { hints?: readonly (string | undefined)[]; ownMs?: number }): Promise<FoundEmail & { mailbox: string }> {
  const chosen = await pickMailbox(stateDir, { address: query.address, hints: query.hints });
  const others = query.address ? [] : (await allStored(stateDir)).map(s => s.email).filter(email => norm(email) !== norm(chosen));
  const total = query.timeoutMs ?? 90_000, own = query.ownMs ?? OWN_MAILBOX_MS;
  const attempt = (address: string, timeoutMs: number, signal?: AbortSignal) => waitForEmail(stateDir, { ...query, address, timeoutMs, signal }) as Promise<FoundEmail & { mailbox: string }>;
  if (!others.length || total <= own) return attempt(chosen, total, query.signal);
  try { return await attempt(chosen, own, query.signal); }
  catch (error) { if (!(error instanceof Error) || !/^No email matched/.test(error.message)) throw error; }
  const stop = new AbortController();
  const signal = query.signal ? AbortSignal.any([query.signal, stop.signal]) : stop.signal;
  try {
    return await Promise.any([chosen, ...others].map(address => attempt(address, total - own, signal)));
  } catch (error) {
    if (query.signal?.aborted) throw error;
    const inner = error instanceof AggregateError ? error.errors : [error];
    const other = inner.find(e => e instanceof Error && !/^No email matched/.test(e.message));
    if (other) throw other;
    throw new Error(`No email matched ${query.site ? `an email for ${vendorOf(query.site)}` : [query.from, query.subject].filter(Boolean).join(' ')} within ${Math.round(total / 1000)} seconds in ${[chosen, ...others].join(', ')}.`);
  } finally { stop.abort(); }
}
