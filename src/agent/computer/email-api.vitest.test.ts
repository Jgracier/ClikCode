import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { disconnectEmail, EMAIL_CLIENT_SECRET, emailConnected, emailStatus, startConsent, waitForEmail, type GoogleEndpoints } from './email-api.js';
import { saveNamedSecret } from './credential-vault.js';
import { verificationCode } from '../tools/computer-web.js';

let dir: string;
let server: http.Server;
let endpoints: GoogleEndpoints;
let refreshes = 0;
let messages: { id: string; internalDate: string; from: string; subject: string; html: string }[] = [];
const b64 = (text: string): string => Buffer.from(text).toString('base64url');

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'email-api-'));
  refreshes = 0;
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
    if (url.pathname === '/gmail/messages') {
      const q = url.searchParams.get('q') ?? '';
      return json({ messages: messages.filter(m => q.includes(m.from)).map(m => ({ id: m.id })) });
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
