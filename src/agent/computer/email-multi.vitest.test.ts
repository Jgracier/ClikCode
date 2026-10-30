import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { disconnectEmail, EMAIL_CLIENT_SECRET, EMAIL_TOKEN_SECRET, emailConnected, emailStatus, findEmail, pickMailbox, startConsent, type GoogleEndpoints } from './email-api.js';
import { readNamedSecret, saveLoginFields, saveNamedSecret } from './credential-vault.js';
import { saveProfile } from './profiles.js';

// Two Google accounts behind one fake endpoint set: the bearer token says which mailbox is asked.
const ME = 'me@example.com', WORK = 'work@clikdeploy.com';
type Msg = { id: string; internalDate: string; from: string; subject: string; html: string };
let dir: string, server: http.Server, endpoints: GoogleEndpoints;
let boxes: Record<string, Msg[]>;
const owner = (bearer: string): string => (bearer.includes('rt2') || bearer.includes('at2') ? WORK : ME);
const b64 = (text: string): string => Buffer.from(text).toString('base64url');
const mail = (id: string, code: string): Msg => ({ id, internalDate: String(Date.now()), from: 'noreply@acme.io', subject: 'Your code', html: `<p>Your verification code is ${code}</p>` });

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'email-multi-'));
  boxes = { [ME]: [], [WORK]: [] };
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const json = (value: unknown, status = 200): void => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value)); };
    if (url.pathname === '/token') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const form = new URLSearchParams(body);
        if (form.get('grant_type') === 'authorization_code') { const n = form.get('code') === 'work' ? '2' : '1'; return json({ access_token: `at${n}`, refresh_token: `rt${n}`, expires_in: 3600 }); }
        return json({ access_token: `at${form.get('refresh_token')!.slice(2)}-r`, expires_in: 3600 });
      });
      return;
    }
    const mailbox = owner(req.headers.authorization ?? '');
    if (url.pathname === '/gmail/profile') return json({ emailAddress: mailbox });
    if (url.pathname === '/gmail/messages') return json({ messages: boxes[mailbox]!.map(m => ({ id: m.id })) });
    const found = /^\/gmail\/messages\/(.+)$/.exec(url.pathname);
    const m = found && boxes[mailbox]!.find(x => x.id === found[1]);
    if (m) return json({ internalDate: m.internalDate, payload: { mimeType: 'multipart/alternative', headers: [{ name: 'From', value: m.from }, { name: 'Subject', value: m.subject }], parts: [{ mimeType: 'text/html', body: { data: b64(m.html) } }] } });
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  endpoints = { auth: `http://127.0.0.1:${port}/auth`, token: `http://127.0.0.1:${port}/token`, gmail: `http://127.0.0.1:${port}/gmail` };
  await saveNamedSecret(dir, EMAIL_CLIENT_SECRET, JSON.stringify({ clientId: 'cid', clientSecret: 'csecret' }));
  query = { site: 'https://acme.io/signup', endpoints, spam: true, consume: false, pollMs: 30 };
  await saveProfile(dir, { label: 'Personal', fields: { sso_email: ME } });
});
afterEach(async () => { server.closeAllConnections(); server.close(); await fs.rm(dir, { recursive: true, force: true }); });

async function connect(code: 'me' | 'work'): Promise<string> {
  const consent = await startConsent(dir, { endpoints });
  const auth = new URL(consent.url);
  const back = new URL(auth.searchParams.get('redirect_uri')!);
  back.searchParams.set('code', code);
  back.searchParams.set('state', auth.searchParams.get('state')!);
  await fetch(back);
  return (await consent.done).email;
}
let query: { site: string; endpoints: GoogleEndpoints; spam: true; consume: false; pollMs: number };

describe('several mailboxes', () => {
  it('connects two accounts side by side, the profile email as default, and neither replaces the other', async () => {
    expect(await connect('work')).toBe(WORK);
    expect(await connect('me')).toBe(ME);
    const status = await emailStatus(dir);
    expect(status).toMatchObject({ connected: true, email: ME });
    expect(status.mailboxes).toMatchObject([{ email: ME, default: true }, { email: WORK, default: false }]);
    expect(JSON.stringify(status)).not.toMatch(/rt\d/);
    expect(await connect('work')).toBe(WORK); // the same account again renews, not duplicates
    expect((await emailStatus(dir)).mailboxes).toHaveLength(2);
  });

  it('moves the old single-mailbox record to the new shape', async () => {
    await saveNamedSecret(dir, EMAIL_TOKEN_SECRET, JSON.stringify({ refreshToken: 'rt1', email: ME, connectedAt: '2026-10-01T00:00:00.000Z' }));
    expect(await emailStatus(dir)).toMatchObject({ connected: true, email: ME, connectedAt: '2026-10-01T00:00:00.000Z' });
    await expect(readNamedSecret(dir, EMAIL_TOKEN_SECRET)).rejects.toThrow();
    boxes[ME] = [mail('a', '482913')];
    expect((await findEmail(dir, { ...query, timeoutMs: 2_000 })).mailbox).toBe(ME);
  });

  it('reads the mailbox named by address, and refuses one that is not connected', async () => {
    await connect('me'); await connect('work');
    boxes[ME] = [mail('a', '111111')]; boxes[WORK] = [mail('b', '222222')];
    const got = await findEmail(dir, { ...query, address: WORK, timeoutMs: 2_000 });
    expect(got).toMatchObject({ id: 'b', mailbox: WORK });
    await expect(pickMailbox(dir, { address: 'nobody@x.io' })).rejects.toThrow(/not a connected mailbox\. Connected: me@example\.com, work@clikdeploy\.com/);
  });

  it('chooses by hint (typed address or saved login), else the default', async () => {
    await connect('me'); await connect('work');
    expect(await pickMailbox(dir, {})).toBe(ME);
    expect(await pickMailbox(dir, { hints: ['stranger@x.io', 'WORK@clikdeploy.com'] })).toBe(WORK);
    await saveLoginFields(dir, 'https://acme.io', { email: WORK, password: 'pw-1' });
    boxes[ME] = [mail('a', '111111')]; boxes[WORK] = [mail('b', '222222')];
    const { loginAddresses } = await import('./email-api.js');
    const hints = await loginAddresses(dir, 'https://acme.io/signup');
    expect(hints).toEqual([WORK]);
    expect(await findEmail(dir, { ...query, hints, timeoutMs: 2_000 })).toMatchObject({ id: 'b', mailbox: WORK });
  });

  it('tries the other mailboxes when the chosen one has nothing after its own wait', async () => {
    await connect('me'); await connect('work');
    boxes[WORK] = [mail('b', '222222')];
    const started = Date.now();
    const got = await findEmail(dir, { ...query, timeoutMs: 3_000, ownMs: 300 });
    expect(got).toMatchObject({ id: 'b', mailbox: WORK });
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  });

  it('does not search the others when an address was demanded, and says where it looked when nothing comes', async () => {
    await connect('me'); await connect('work');
    boxes[WORK] = [mail('b', '222222')];
    await expect(findEmail(dir, { ...query, address: ME, timeoutMs: 600, ownMs: 200 })).rejects.toThrow(/No email matched/);
    await expect(findEmail(dir, { ...query, timeoutMs: 600, ownMs: 200, site: 'https://nothing-here.io/' })).rejects.toThrow(/No email matched.*me@example\.com, work@clikdeploy\.com/);
  });

  it('disconnects one mailbox and leaves the other', async () => {
    await connect('me'); await connect('work');
    expect(await disconnectEmail(dir, WORK)).toBe(true);
    expect(await emailConnected(dir, WORK)).toBe(false);
    expect(await emailConnected(dir, ME)).toBe(true);
    expect((await emailStatus(dir)).mailboxes.map(m => m.email)).toEqual([ME]);
    expect(await disconnectEmail(dir, WORK)).toBe(false);
  });
});
