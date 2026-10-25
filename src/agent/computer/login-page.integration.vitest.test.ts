/** The login flow against a real Chrome and a local HTTPS sign-in site with
 * real form posts and redirects. Opt in with CLIKCODE_COMPUTER_SMOKE=1. */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHttps, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { lockCredentialVault, saveLoginFields, savedLoginFields, savedLoginsForSite } from './credential-vault.js';
import type { LoginField } from './login-fields.js';
import { loginComputerPage } from './login-page.js';

const enabled = process.env.CLIKCODE_COMPUTER_SMOKE === '1';
const NEW_ACCOUNT = 'Use a different account';
const page = (title: string, body: string): string => `<!doctype html><title>${title}</title><body>${body}</body>`;
const form = (action: string, label: string, name: string, type: string, autocomplete: string, error: boolean): string => page(label,
  `<form method="post" action="${action}">${error ? '<p>That did not work. Try again.</p>' : ''}<label>${label}<input name="${name}" type="${type}" autocomplete="${autocomplete}"></label></form>`);

let server: Server | undefined;
let browser: Browser | undefined;
let base = '';
let work = '';
let stateDir = '';
let mfa = false;
/** What the sign-in site received, in order, so a test can see the right values arrived. */
let received: string[] = [];

beforeAll(async () => {
  if (!enabled) return;
  work = await mkdtemp(join(tmpdir(), 'clikcode-login-site-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(work, 'key.pem'), '-out', join(work, 'cert.pem'),
    '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  server = createHttps({ key: await readFile(join(work, 'key.pem')), cert: await readFile(join(work, 'cert.pem')) }, (request, response) => {
    const url = new URL(request.url ?? '/', 'https://127.0.0.1');
    const send = (html: string): void => { response.setHeader('content-type', 'text/html'); response.end(html); };
    const go = (to: string): void => { response.writeHead(303, { location: to }).end(); };
    const error = url.searchParams.has('error');
    if (request.method === 'POST') {
      let body = '';
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        const value = new URLSearchParams(body).values().next().value ?? '';
        received.push(`${url.pathname}=${value}`);
        if (url.pathname === '/signin/identifier') go('/signin/pwd');
        else if (url.pathname === '/hop/pwd') go(`https://localhost:${(server!.address() as { port: number }).port}/signin/pwd?error=1`);
        else if (url.pathname === '/signin/pwd') go(value.startsWith('correct') ? (mfa ? '/signin/challenge/totp' : '/home') : '/signin/pwd?error=1');
        else go(value === '123456' ? '/home' : '/signin/challenge/totp?error=1');
      });
      return;
    }
    if (url.pathname === '/signin/identifier') send(form('/signin/identifier', 'Email or phone', 'identifier', 'text', 'username', error));
    else if (url.pathname === '/hop/pwd') send(form('/hop/pwd', 'Enter your password', 'password', 'password', 'current-password', false));
    else if (url.pathname === '/signin/pwd') send(form('/signin/pwd', 'Enter your password', 'password', 'password', 'current-password', error));
    else if (url.pathname === '/signin/challenge/totp') send(form('/signin/challenge/totp', 'Enter the 6-digit code', 'totp', 'text', 'one-time-code', error));
    else if (url.pathname === '/embedded') send(page('Embedded', '<h1>Pay</h1><iframe src="/signin/identifier" width="400" height="200"></iframe>'));
    else if (url.pathname === '/signin/jsform') send(page('JS form', '<label>Email or phone<input name="identifier" type="text" autocomplete="username"></label><button type="button" onclick="location=\'/signin/pwd\'">Next</button>'));
    else if (url.pathname === '/signin/late') send(page('Late', '<div id="m"></div><script>setTimeout(() => { document.getElementById("m").innerHTML = `<form method="post" action="/signin/identifier"><label>Email or phone<input name="identifier" type="text" autocomplete="username"></label></form>` }, 2500)</script>'));
    else if (request.headers['sec-fetch-dest'] === 'iframe') send(page('Done', '<script>top.location = "/home"</script>'));
    else send(page('Home', '<h1>Welcome</h1>'));
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  base = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.close();
  if (work) await rm(work, { recursive: true, force: true });
});

afterEach(async () => {
  if (stateDir) { lockCredentialVault(stateDir); await rm(stateDir, { recursive: true, force: true }); stateDir = ''; }
  received = [];
  mfa = false;
});

async function signIn(answers: Record<string, string>, options: { newAccount?: boolean; start?: string } = {}): Promise<{ outcome: string; asked: string[][]; options: (readonly string[] | undefined)[]; at: string; page: Page }> {
  const context = await browser!.newContext({ ignoreHTTPSErrors: true });
  const tab = await context.newPage();
  await tab.goto(`${base}${options.start ?? '/signin/identifier'}`);
  const asked: string[][] = [];
  const offered: (readonly string[] | undefined)[] = [];
  const outcome = await loginComputerPage({
    stateDir, page: tab, newAccount: options.newAccount,
    ask: async (_site: string, fields: readonly LoginField[]) => {
      asked.push(fields.map(field => field.key));
      offered.push(fields[0]!.options);
      return Object.fromEntries(fields.map(field => [field.key, answers[field.key]!]));
    },
  });
  return { outcome, asked, options: offered, at: new URL(tab.url()).pathname, page: tab };
}

it.skipIf(!enabled)('signs in with email, password and a one-time code, saving the login but never the code', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-login-real-'));
  mfa = true;
  const result = await signIn({ username: 'one@example.com', password: 'correct-one', code: '123456' });
  expect(result).toMatchObject({ outcome: 'signed_in', asked: [['username', 'password'], ['code']], at: '/home' });
  expect(received).toEqual(['/signin/identifier=one@example.com', '/signin/pwd=correct-one', '/signin/challenge/totp=123456']);
  const [saved] = await savedLoginsForSite(stateDir, `${base}/`);
  expect(saved!.label).toBe('one@example.com');
  expect(Object.keys(await savedLoginFields(stateDir, `${base}/`, saved!.id)).sort()).toEqual(['password', 'username']);

  // Next time only the code is asked for, because it is the one thing not kept.
  received = [];
  const again = await signIn({ code: '123456' });
  expect(again).toMatchObject({ outcome: 'signed_in', asked: [['code']], at: '/home' });
  expect(received).toEqual(['/signin/identifier=one@example.com', '/signin/pwd=correct-one', '/signin/challenge/totp=123456']);
}, 60_000);

it.skipIf(!enabled)('does not save a login the site rejected', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-login-real-'));
  const result = await signIn({ username: 'one@example.com', password: 'wrong' });
  expect(result.outcome).toBe('unverified');
  expect(result.at).toBe('/signin/pwd');
  expect(await savedLoginsForSite(stateDir, `${base}/`)).toEqual([]);
}, 60_000);

it.skipIf(!enabled)('stops after two wrong codes instead of guessing again', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-login-real-'));
  mfa = true;
  const result = await signIn({ username: 'one@example.com', password: 'correct-one', code: '000000' });
  expect(result.outcome).toBe('unverified');
  expect(received.filter(line => line.startsWith('/signin/challenge/totp'))).toHaveLength(2);
  expect(await savedLoginsForSite(stateDir, `${base}/`)).toEqual([]);
}, 60_000);

it.skipIf(!enabled)('offers the saved accounts when there are several and signs in with the chosen one', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-login-real-'));
  await saveLoginFields(stateDir, `${base}/`, { username: 'one@example.com', password: 'correct-one' });
  await saveLoginFields(stateDir, `${base}/`, { username: 'two@example.com', password: 'correct-two' });
  const result = await signIn({ account: 'two@example.com' });
  expect(result).toMatchObject({ outcome: 'signed_in', asked: [['account']], at: '/home' });
  expect(result.options[0]).toEqual(['one@example.com', 'two@example.com', NEW_ACCOUNT]);
  expect(received).toEqual(['/signin/identifier=two@example.com', '/signin/pwd=correct-two']);
}, 60_000);

it.skipIf(!enabled)('uses the one saved account without asking, and replaces its password after the site refuses it', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-login-real-'));
  const id = await saveLoginFields(stateDir, `${base}/`, { username: 'one@example.com', password: 'stale' });
  const refused = await signIn({});
  expect(refused).toMatchObject({ outcome: 'saved_login_rejected', asked: [] });
  expect((await savedLoginsForSite(stateDir, `${base}/`))[0]).toMatchObject({ id, rejected: true });

  received = [];
  const fixed = await signIn({ account: NEW_ACCOUNT, username: 'one@example.com', password: 'correct-new' });
  expect(fixed).toMatchObject({ outcome: 'signed_in', asked: [['account'], ['username', 'password']] });
  expect(await savedLoginsForSite(stateDir, `${base}/`)).toEqual([{ id, label: 'one@example.com', rejected: false }]);
  expect((await savedLoginFields(stateDir, `${base}/`, id)).password).toBe('correct-new');
}, 60_000);

it.skipIf(!enabled)('signs in through a form embedded in an iframe', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-login-real-'));
  const result = await signIn({ username: 'one@example.com', password: 'correct-one' }, { start: '/embedded' });
  expect(result).toMatchObject({ outcome: 'signed_in', asked: [['username', 'password']], at: '/home' });
  expect(received).toEqual(['/signin/identifier=one@example.com', '/signin/pwd=correct-one']);
}, 60_000);

it.skipIf(!enabled)('clicks the button when Enter does not submit the form', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-login-real-'));
  const result = await signIn({ username: 'one@example.com', password: 'correct-one' }, { start: '/signin/jsform' });
  expect(result).toMatchObject({ outcome: 'signed_in', asked: [['username', 'password']], at: '/home' });
  expect(received).toEqual(['/signin/pwd=correct-one']);
}, 60_000);

it.skipIf(!enabled)('waits for a form that is drawn a moment after the page opens', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-login-real-'));
  const result = await signIn({ username: 'one@example.com', password: 'correct-one' }, { start: '/signin/late' });
  expect(result).toMatchObject({ outcome: 'signed_in', at: '/home' });
}, 60_000);

it.skipIf(!enabled)('marks a saved login rejected when the refusal comes on another host than the one it was saved for, and does not send it again', async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-login-hop-'));
  const id = await saveLoginFields(stateDir, `${base}/`, { username: 'one@example.com', password: 'stale' });
  const refused = await signIn({}, { start: '/hop/pwd' });
  expect(refused).toMatchObject({ outcome: 'saved_login_rejected' });
  expect((await savedLoginsForSite(stateDir, `${base}/`))[0]).toMatchObject({ id, rejected: true });

  // Choosing the refused account again asks for a password instead of sending the stale one.
  received = [];
  const again = await signIn({ account: 'one@example.com', password: 'correct-new' });
  expect(again.asked[0]).toEqual(['account']);
  expect(received.some(line => line.endsWith('=stale'))).toBe(false);
  expect(again.asked.flat()).toContain('password');
  expect(again.outcome).toBe('signed_in');
}, 60_000);
