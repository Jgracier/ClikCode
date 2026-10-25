import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMAIL_CLIENT_SECRET, senderMatch, startConsent, type GoogleEndpoints } from './email-api.js';
import { codeFromMailbox, emailedCode, holdForEmail, looksLikeCodeEmail, looksLikeLinkEmail, verificationCode } from './email-code.js';
import { saveNamedSecret } from './credential-vault.js';
import { Parked } from './parking.js';
import { listTasks } from './work-queue.js';

let dir: string;
let server: http.Server;
let endpoints: GoogleEndpoints;
type Msg = { id: string; at: number; from: string; subject: string; html: string; spam?: boolean };
let messages: Msg[] = [];
const b64 = (text: string): string => Buffer.from(text).toString('base64url');
const mail = (id: string, from: string, code: string, extra: Partial<Msg> = {}): Msg => ({ id, at: Date.now(), from, subject: `Your code`, html: `<p>Your verification code is <b>${code}</b></p>`, ...extra });

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'email-code-'));
  messages = [];
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const json = (value: unknown, status = 200): void => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value)); };
    if (url.pathname === '/token') { req.resume(); req.on('end', () => json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 })); return; }
    if (url.pathname === '/gmail/profile') return json({ emailAddress: 'me@example.com' });
    if (url.pathname === '/gmail/messages') {
      const withSpam = url.searchParams.get('includeSpamTrash') === 'true';
      return json({ messages: messages.filter(m => withSpam || !m.spam).map(m => ({ id: m.id })) });
    }
    const match = /^\/gmail\/messages\/(.+)$/.exec(url.pathname);
    if (match) {
      const m = messages.find(x => x.id === match[1])!;
      return json({ internalDate: String(m.at), payload: { mimeType: 'multipart/alternative', headers: [{ name: 'From', value: m.from }, { name: 'Subject', value: m.subject }], parts: [{ mimeType: 'text/html', body: { data: b64(m.html) } }] } });
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  endpoints = { auth: `http://127.0.0.1:${port}/auth`, token: `http://127.0.0.1:${port}/token`, gmail: `http://127.0.0.1:${port}/gmail` };
  await saveNamedSecret(dir, EMAIL_CLIENT_SECRET, JSON.stringify({ clientId: 'cid', clientSecret: 'cs' }));
  const consent = await startConsent(dir, { endpoints });
  const auth = new URL(consent.url);
  const back = new URL(auth.searchParams.get('redirect_uri')!);
  back.searchParams.set('code', 'good'); back.searchParams.set('state', auth.searchParams.get('state')!);
  await fetch(back); await consent.done;
});
afterEach(async () => { server.closeAllConnections(); server.close(); await fs.rm(dir, { recursive: true, force: true }); });

const fast = { passMs: 250, pollMs: 40 };

describe('which email belongs to a site', () => {
  it('matches the sender domain or name first, then the subject, then the start of the body', () => {
    expect(senderMatch({ from: 'Acme <no-reply@mail.acme.io>', subject: 'x', text: 'x' }, 'https://app.acme.io/signup').tier).toBe(1);
    expect(senderMatch({ from: 'Acme Team <hello@sendgrid.net>', subject: 'x', text: 'x' }, 'https://acme.io').tier).toBe(1);
    expect(senderMatch({ from: 'noreply@sendgrid.net', subject: 'Your Acme code', text: 'x' }, 'https://acme.io').tier).toBe(2);
    expect(senderMatch({ from: 'noreply@sendgrid.net', subject: 'Code', text: 'Welcome to Acme. Your code is 123456' }, 'https://acme.io').tier).toBe(3);
    expect(senderMatch({ from: 'noreply@other.com', subject: 'Code', text: 'Your code is 123456' }, 'https://acme.io').tier).toBe(0);
    expect(senderMatch({ from: 'Pipe <a@pipedrive.com>', subject: '', text: '' }, 'https://oauth.pipedrive.com/x').tier).toBe(1);
  });
});

describe('the emailed code', () => {
  it('gives each agent the code from its own site when two signups wait on one mailbox', async () => {
    messages = [mail('a', 'no-reply@acme.io', '111111'), mail('b', 'no-reply@globex.com', '222222')];
    const [acme, globex] = await Promise.all([
      emailedCode(dir, { site: 'https://acme.io/signup', since: Date.now() - 60_000, endpoints, ...fast }),
      emailedCode(dir, { site: 'https://globex.com/join', since: Date.now() - 60_000, endpoints, ...fast }),
    ]);
    expect(acme).toEqual({ code: '111111' });
    expect(globex).toEqual({ code: '222222' });
  });

  it('hands one email to one waiter only', async () => {
    messages = [mail('only', 'no-reply@acme.io', '333333')];
    const results = await Promise.all([1, 2].map(() => emailedCode(dir, { site: 'https://acme.io', since: Date.now() - 60_000, endpoints, passes: 1, ...fast })));
    expect(results.filter(r => 'code' in r)).toHaveLength(1);
    expect(results.filter(r => 'hold' in r)).toHaveLength(1);
  });

  it('does not choose between two different senders that both fit', async () => {
    messages = [mail('x', 'no-reply@acme.io', '444444'), mail('y', 'Acme <support@lookalike.net>', '555555')];
    const result = await emailedCode(dir, { site: 'https://acme.io', since: Date.now() - 60_000, endpoints, ...fast });
    expect(result).toMatchObject({ hold: expect.stringMatching(/not choosing between them/) });
  });

  it('takes the newest of a resend from the same sender', async () => {
    messages = [mail('old', 'no-reply@acme.io', '111111', { at: Date.now() - 20_000 }), mail('new', 'no-reply@acme.io', '999999')];
    expect(await emailedCode(dir, { site: 'https://acme.io', since: Date.now() - 60_000, endpoints, ...fast })).toEqual({ code: '999999' });
  });

  it('ignores mail from before the page asked and mail with no code', async () => {
    messages = [mail('stale', 'no-reply@acme.io', '123123', { at: Date.now() - 600_000 }), { ...mail('hello', 'no-reply@acme.io', '000000'), html: '<p>Welcome to Acme!</p>' }];
    expect(await emailedCode(dir, { site: 'https://acme.io', since: Date.now() - 60_000, endpoints, passes: 1, ...fast })).toMatchObject({ hold: expect.stringMatching(/no email with a code for acme/) });
  });

  it('looks in spam on a later pass, not the first', async () => {
    messages = [mail('spam', 'no-reply@acme.io', '777777', { spam: true })];
    expect(await emailedCode(dir, { site: 'https://acme.io', since: Date.now() - 60_000, endpoints, passes: 1, ...fast })).toMatchObject({ hold: expect.any(String) });
    expect(await emailedCode(dir, { site: 'https://acme.io', since: Date.now() - 60_000, endpoints, passes: 3, ...fast })).toEqual({ code: '777777' });
  });

  it('waits for mail that has not come yet, within the passes', async () => {
    setTimeout(() => { messages = [mail('late', 'no-reply@acme.io', '888888')]; }, 300);
    expect(await emailedCode(dir, { site: 'https://acme.io', since: Date.now() - 60_000, endpoints, passes: 4, ...fast })).toEqual({ code: '888888' });
  });
});

describe('putting a signup on hold', () => {
  it('records a needs-human email task and stops the step with a plain message', async () => {
    await expect(holdForEmail(dir, 'https://app.acme.io/verify', 'nothing arrived')).rejects.toBeInstanceOf(Parked);
    const [task] = await listTasks(dir, { reason: 'email' });
    expect(task).toMatchObject({ vendor: 'acme', status: 'needs-human', reason: 'email' });
    expect(task!.note).toContain('nothing arrived');
  });

  it('returns nothing, and asks nobody, when no mailbox is connected', async () => {
    const lone = await fs.mkdtemp(path.join(os.tmpdir(), 'email-none-'));
    try { expect(await codeFromMailbox(lone, 'https://acme.io', Date.now())).toBeUndefined(); } finally { await fs.rm(lone, { recursive: true, force: true }); }
  });

  it('reads codes the way the old reader did', () => {
    expect(verificationCode('Your verification code is 482913')).toBe('482913');
    expect(verificationCode('PIN: 6TPFBF is your code')).toBe('6TPFBF');
  });
});

describe('verification mail, not marketing', () => {
  it('rejects a newsletter that holds a number, accepts a code message', () => {
    expect(looksLikeCodeEmail({ subject: 'Security New Features in September 2026', text: 'Read the new features. Reference 123456 for the webinar.' })).toBe(false);
    expect(looksLikeCodeEmail({ subject: 'Your Acme verification code', text: 'Your verification code is 482913' })).toBe(true);
    expect(looksLikeCodeEmail({ subject: 'Welcome', text: 'Welcome. Your code: 482913' })).toBe(true);
    expect(looksLikeLinkEmail({ subject: 'Confirm your email', text: 'Click to confirm', links: ['https://acme.io/c?t=1'] })).toBe(true);
    expect(looksLikeLinkEmail({ subject: 'Our September newsletter', text: 'read more', links: ['https://acme.io/blog'] })).toBe(false);
  });

  it('does not type a newsletter that arrives after the page asked', async () => {
    messages = [{ ...mail('news', 'newsletter@info.acme.io', '123456'), subject: 'Security New Features in September', html: '<p>New features this month. Ref 123456.</p>' }];
    expect(await emailedCode(dir, { site: 'https://acme.io', since: Date.now() - 60_000, endpoints, passes: 1, ...fast })).toMatchObject({ hold: expect.any(String) });
  });
});
