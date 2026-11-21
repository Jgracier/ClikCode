import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senderMatch, disconnectEmail, EMAIL_CLIENT_SECRET, emailConnected, emailStatus, startConsent, waitForEmail, type GoogleEndpoints } from './email-api.js';
import { saveNamedSecret } from './credential-vault.js';
import { verificationCode } from '../tools/computer-web.js';
import { saveProfile } from './profiles.js';

let dir: string;
let server: http.Server;
let endpoints: GoogleEndpoints;
let refreshes = 0;
let pageSize = 100;
let stallListing = false;
let messages: { id: string; internalDate: string; from: string; subject: string; html: string }[] = [];
const b64 = (text: string): string => Buffer.from(text).toString('base64url');

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'email-api-'));
  refreshes = 0;
  pageSize = 100;
  stallListing = false;
  messages = [];
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const json = (value: unknown, status = 200): void => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value)); };
    if (url.pathname === '/token') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const form = new URLSearchParams(body);
        if (form.get('grant_type') === 'authorization_code') return json(form.get('code') === 'good' && form.get('code_verifier') ? { access_token: 'at1', refresh_token: 'rt1', expires_in: 3600 } : { error: 'invalid_grant' }, form.get('code') === 'good' ? 200 : 400);
        refreshes++;
        return json(form.get('refresh_token') === 'rt1' ? { access_token: `at-refresh-${refreshes}`, expires_in: 3600 } : { error: 'invalid_grant' }, form.get('refresh_token') === 'rt1' ? 200 : 400);
      });
      return;
    }
    if (url.pathname === '/gmail/profile') return json({ emailAddress: 'me@example.com' });
    if (url.pathname === '/gmail-other/profile') return json({ emailAddress: 'other@example.com' });
    if (url.pathname === '/gmail/messages') {
      if (stallListing) return;
      const q = url.searchParams.get('q') ?? '';
      const matching = messages.filter(m => !q.includes('from:(') || q.includes(m.from));
      const offset = Number(url.searchParams.get('pageToken') ?? 0);
      return json({ messages: matching.slice(offset, offset + pageSize).map(m => ({ id: m.id })), ...(offset + pageSize < matching.length ? { nextPageToken: String(offset + pageSize) } : {}) });
    }
    const match = /^\/gmail\/messages\/(.+)$/.exec(url.pathname);
    if (match) {
      const m = messages.find(x => x.id === match[1])!;
      return json({ internalDate: m.internalDate, payload: { mimeType: 'multipart/alternative', headers: [{ name: 'From', value: m.from }, { name: 'Subject', value: m.subject }], parts: [{ mimeType: 'text/html', body: { data: b64(m.html) } }] } });
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  endpoints = { auth: `http://127.0.0.1:${port}/auth`, token: `http://127.0.0.1:${port}/token`, gmail: `http://127.0.0.1:${port}/gmail` };
  await saveNamedSecret(dir, EMAIL_CLIENT_SECRET, JSON.stringify({ clientId: 'cid', clientSecret: 'csecret' }));
});
afterEach(async () => { server.closeAllConnections(); server.close(); await fs.rm(dir, { recursive: true, force: true }); });

async function connect(): Promise<void> {
  const consent = await startConsent(dir, { loginHint: 'me@example.com', endpoints });
  const auth = new URL(consent.url);
  expect(auth.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/gmail.readonly');
  expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
  expect(auth.searchParams.get('access_type')).toBe('offline');
  expect(auth.searchParams.get('login_hint')).toBe('me@example.com');
  const back = new URL(auth.searchParams.get('redirect_uri')!);
  back.searchParams.set('code', 'good');
  back.searchParams.set('state', auth.searchParams.get('state')!);
  expect((await fetch(back)).ok).toBe(true);
  expect((await consent.done).email).toBe('me@example.com');
}

describe('mailbox consent', () => {
  it('adds a mailbox for a consent by another account and keeps the profile email mailbox', async () => {
    await saveProfile(dir, { label: 'Personal', fields: { sso_email: 'me@example.com' } });
    await connect();
    const other = await startConsent(dir, { endpoints: { ...endpoints, gmail: `${endpoints.gmail}-other` } });
    const auth = new URL(other.url);
    const back = new URL(auth.searchParams.get('redirect_uri')!);
    back.searchParams.set('code', 'good');
    back.searchParams.set('state', auth.searchParams.get('state')!);
    await fetch(back);
    expect((await other.done).email).toBe('other@example.com');
    const status = await emailStatus(dir);
    expect(status.email).toBe('me@example.com');
    expect(status.mailboxes.map(m => m.email)).toEqual(['me@example.com', 'other@example.com']);
  });

  it('stores the refresh token as a secret after one consent, and says which mailbox, never the token', async () => {
    expect(await emailConnected(dir)).toBe(false);
    await connect();
    expect(await emailStatus(dir)).toMatchObject({ connected: true, email: 'me@example.com' });
    expect(JSON.stringify(await emailStatus(dir))).not.toContain('rt1');
    expect(await disconnectEmail(dir)).toBe(true);
    expect(await emailConnected(dir)).toBe(false);
  });

  it('refuses a redirect with the wrong state and stores nothing', async () => {
    const consent = await startConsent(dir, { endpoints });
    const back = new URL(new URL(consent.url).searchParams.get('redirect_uri')!);
    back.searchParams.set('code', 'good');
    back.searchParams.set('state', 'forged');
    await fetch(back);
    await expect(consent.done).rejects.toThrow(/did not match/);
    expect(await emailConnected(dir)).toBe(false);
  });

  it('says what to set up when there is no OAuth client', async () => {
    await fs.rm(path.join(dir, 'computer'), { recursive: true, force: true });
    await expect(startConsent(dir, { endpoints })).rejects.toThrow(/No Google OAuth client/);
  });
});

describe('sender matching for a vendor that mails through an unrelated service', () => {
  const body = `${'Welcome aboard. '.repeat(40)}Confirm your Who Hosts This account with the code below. 482913`;
  const mail = { from: 'Accounts <bounce@mail.sendgrid-esp.net>', subject: 'Your code', text: body };
  it('misses a vendor named only past the first 400 characters, unless widened', () => {
    expect(body.indexOf('Who Hosts This')).toBeGreaterThan(400);
    expect(senderMatch(mail, 'https://who-hosts-this.com/account').tier).toBe(0);
    expect(senderMatch(mail, 'https://who-hosts-this.com/account', { widen: true }).tier).toBe(3);
    expect(senderMatch({ ...mail, text: 'x'.repeat(1600) + ' Who Hosts This' }, 'https://who-hosts-this.com/', { widen: true }).tier).toBe(0);
  });

  it('widens only when one real email arrived: a lone one is taken, two are not guessed between', async () => {
    await connect();
    const now = Date.now();
    messages = [{ id: 'only', internalDate: String(now), from: 'bounce@mail.sendgrid-esp.net', subject: 'Your code', html: `<p>${body}</p>` }];
    const mail = await waitForEmail(dir, { site: 'https://who-hosts-this.com/account', endpoints, timeoutMs: 3_000, pollMs: 50 });
    expect(mail.id).toBe('only');
    messages = [...messages, { id: 'other', internalDate: String(now), from: 'noreply@other-esp.org', subject: 'Hello', html: '<p>Another notice about something else.</p>' }];
    await expect(waitForEmail(dir, { site: 'https://who-hosts-this.com/account', endpoints, timeoutMs: 300, pollMs: 50 })).rejects.toThrow(/No email matched/);
  });

  it('does not count a newsletter as the second email', async () => {
    await connect();
    const now = Date.now();
    messages = [
      { id: 'code', internalDate: String(now), from: 'bounce@mail.sendgrid-esp.net', subject: 'Your code', html: `<p>${body}</p>` },
      { id: 'news', internalDate: String(now), from: 'news@other.org', subject: 'Monthly newsletter', html: '<p>What is new this month</p>' },
    ];
    expect((await waitForEmail(dir, { site: 'https://who-hosts-this.com/', endpoints, timeoutMs: 3_000, pollMs: 50 })).id).toBe('code');
  });
});

describe('waiting for mail', () => {
  it('returns the newest matching email as text and links, as soon as it is there', async () => {
    await connect();
    const now = Date.now();
    messages = [
      { id: 'old', internalDate: String(now - 3_600_000), from: 'noreply@acme.io', subject: 'Old', html: '<p>Your code is 111111</p>' },
      { id: 'new', internalDate: String(now), from: 'noreply@acme.io', subject: 'Verify', html: '<p>Your verification code is <b>482913</b></p><a href="https://acme.io/confirm?t=1&amp;u=2">Confirm</a>' },
    ];
    const mail = await waitForEmail(dir, { from: 'noreply@acme.io', endpoints, timeoutMs: 5_000, pollMs: 50 });
    expect(mail.subject).toBe('Verify');
    expect(verificationCode(mail.text)).toBe('482913');
    expect(mail.links).toEqual(['https://acme.io/confirm?t=1&u=2']);
  });

  it('reads a link whose href has no quotes (Twilio\'s reset button), with its anchor text', async () => {
    await connect();
    messages = [{ id: 'reset', internalDate: String(Date.now()), from: 'no-reply@twilio.com', subject: 'Password reset requested', html: '<a class="reset_password_anchor" href=https://links.example/ls/click?upn=reset>Reset your password</a> <a href="https://links.example/ls/click?upn=docs">Support</a>' }];
    const mail = await waitForEmail(dir, { from: 'no-reply@twilio.com', endpoints, timeoutMs: 5_000, pollMs: 50 });
    expect(mail.links).toEqual(['https://links.example/ls/click?upn=reset', 'https://links.example/ls/click?upn=docs']);
    expect(mail.anchors?.[0]).toMatchObject({ href: 'https://links.example/ls/click?upn=reset', text: 'Reset your password' });
  });

  it('waits for an email that has not arrived yet, then returns it', async () => {
    await connect();
    setTimeout(() => { messages = [{ id: 'late', internalDate: String(Date.now()), from: 'hello@vendor.com', subject: 'Code', html: 'Your code: 654321' }]; }, 200);
    const mail = await waitForEmail(dir, { from: 'hello@vendor.com', endpoints, timeoutMs: 5_000, pollMs: 50 });
    expect(verificationCode(mail.text)).toBe('654321');
  });

  it('gives up with a plain reason when nothing arrives', async () => {
    await connect();
    await expect(waitForEmail(dir, { from: 'nobody@x.io', endpoints, timeoutMs: 300, pollMs: 50 })).rejects.toThrow(/No email matched .* within/);
  });

  it('ignores an email older than the window and refreshes the access token only when it has expired', async () => {
    await connect();
    messages = [{ id: 'stale', internalDate: String(Date.now() - 3_600_000), from: 'a@b.io', subject: 's', html: 'code 123456' }];
    await expect(waitForEmail(dir, { from: 'a@b.io', endpoints, timeoutMs: 200, pollMs: 50 })).rejects.toThrow(/No email matched/);
    expect(refreshes).toBe(0);
  });

  it('needs a sender or subject, and a connected mailbox', async () => {
    await expect(waitForEmail(dir, { endpoints })).rejects.toThrow(/sender/);
    await expect(waitForEmail(dir, { from: 'a@b.io', endpoints })).rejects.toThrow(/No mailbox is connected/);
  });
});

describe('the words of a message', () => {
  it('reads the HTML when the plain part is a stub ("none"), and keeps a real plain part', async () => {
    const { mailText } = await import('./email-api.js');
    expect(mailText('none', '<p>Your One-Time Password is <b>482913</b>. It expires in 10 minutes.</p>')).toContain('482913');
    expect(mailText('Your code is 111222. Enter it on the sign-in page to continue.', '<p>Your code is <b>111222</b></p>')).toBe('Your code is 111222. Enter it on the sign-in page to continue.');
    expect(mailText('', '<p>Hello</p>')).toBe('Hello');
  });
});

it('finds verification mail beyond the first Gmail page', async () => {
  await connect();
  pageSize = 20;
  messages = Array.from({ length: 21 }, (_, i) => ({ id: String(i), internalDate: String(Date.now()), from: i === 20 ? 'accounts@acme.io' : 'news@unrelated.io', subject: i === 20 ? 'Verification' : 'Newsletter', html: i === 20 ? 'Your code is 482913' : 'Weekly news' }));
  expect(await waitForEmail(dir, { site: 'https://acme.io', endpoints, timeoutMs: 3000 })).toMatchObject({ id: '20' });
});

it('cancels an in-flight Gmail request when the caller stops', async () => {
  await connect();
  stallListing = true;
  const controller = new AbortController();
  const pending = waitForEmail(dir, { site: 'https://acme.io', endpoints, signal: controller.signal });
  const reason = new Error('Vendor run stopped');
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
});

it('bounds a stalled Gmail request by the verification wait, not the fetch timeout', async () => {
  await connect();
  stallListing = true;
  await expect(waitForEmail(dir, { site: 'https://acme.io', endpoints, timeoutMs: 100 })).rejects.toThrow(/No email matched/);
}, 1000);
