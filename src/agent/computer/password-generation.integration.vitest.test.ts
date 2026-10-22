/** Generated per-site passwords against a real Chrome and a local HTTPS sign-up site that really validates the password
 * on the server. Opt in with CLIKCODE_COMPUTER_SMOKE=1. */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHttps, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import type { ToolContext } from '../tool-contract.js';
import { runSteps } from '../tools/computer-web.js';
import { lockCredentialVault, saveLoginFields, savedLoginFields, savedLoginsForSite } from './credential-vault.js';
import { listTasks } from './work-queue.js';
import { readPasswordPolicy } from './password-retry.js';
import { setGeneratedPasswords } from './settings.js';

const enabled = process.env.CLIKCODE_COMPUTER_SMOKE === '1';

/** What each fake site accepts. `error` is what it says when it refuses. */
const SITES: Record<string, { ok: (password: string) => boolean; error: string; hint?: string; attrs?: string }> = {
  plain: { ok: password => password.length >= 12, error: 'Password must be at least 12 characters.', hint: 'Use at least 12 characters.' },
  attrs: { ok: password => password.length >= 16 && password.length <= 20, error: 'Password must be 16 to 20 characters.', attrs: 'minlength="16" maxlength="20"' },
  hinted: { ok: password => /^[A-Za-z0-9]{8,16}$/.test(password), error: 'Password must be 8-16 letters and numbers.', hint: '8-16 characters, no special characters.' },
  strict: { ok: password => /^[A-Za-z0-9]{1,12}$/.test(password), error: 'Password must be at most 12 characters and cannot contain special characters.' },
  never: { ok: () => false, error: 'Password is too weak. Use at least 12 characters.' },
};

let server: Server | undefined;
let browser: Browser | undefined;
let base = '';
let work = '';
let stateDir = '';
const made: string[] = [];
/** The passwords the sites received, in order, per site. */
let received: Record<string, string[]> = {};

const signupPage = (site: string, email: string, error: string): string => {
  const spec = SITES[site]!;
  return `<!doctype html><title>Sign up</title><body><h1>Create your account</h1>
    <form method="post" action="/signup/${site}">
      <label>Email <input name="email" type="email" value="${email}"></label>
      <label>Password <input name="pw" type="password" autocomplete="new-password" ${spec.attrs ?? ''}></label>
      <label>Confirm password <input name="pw2" type="password" autocomplete="new-password" ${spec.attrs ?? ''}></label>
      ${spec.hint ? `<p class="hint">${spec.hint}</p>` : ''}
      ${error ? `<p class="error" role="alert">${error}</p>` : ''}
      <button type="submit">Create account</button></form></body>`;
};

beforeAll(async () => {
  if (!enabled) return;
  work = await mkdtemp(join(tmpdir(), 'clikcode-pw-site-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(work, 'key.pem'), '-out', join(work, 'cert.pem'),
    '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  server = createHttps({ key: await readFile(join(work, 'key.pem')), cert: await readFile(join(work, 'cert.pem')) }, (request, response) => {
    const url = new URL(request.url ?? '/', 'https://127.0.0.1');
    const [, area, site] = url.pathname.split('/');
    const send = (html: string): void => { response.setHeader('content-type', 'text/html'); response.end(html); };
    if (area === 'signup' && site && SITES[site]) {
      if (request.method !== 'POST') return send(signupPage(site, '', ''));
      let body = '';
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        const form = new URLSearchParams(body);
        const password = form.get('pw') ?? '';
        (received[site] ??= []).push(password);
        const problem = password !== form.get('pw2') ? 'Passwords do not match.' : SITES[site]!.ok(password) ? '' : SITES[site]!.error;
        if (problem) send(signupPage(site, form.get('email') ?? '', problem));
        else response.writeHead(303, { location: '/welcome' }).end();
      });
      return;
    }
    if (area === 'signin') return send('<!doctype html><title>Sign in</title><h1>Sign in</h1><form><label>Email <input name="email" type="email" autocomplete="username"></label><label>Password <input name="pw" type="password" autocomplete="current-password"></label></form>');
    send('<!doctype html><title>Welcome</title><h1>Welcome</h1>');
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  base = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, 60_000);

afterAll(async () => { await browser?.close(); server?.close(); if (work) await rm(work, { recursive: true, force: true }); });
afterEach(async () => { for (const dir of made.splice(0)) { lockCredentialVault(dir); await rm(dir, { recursive: true, force: true }); } stateDir = ''; received = {}; });

/** Opens a fake sign-up page. Each page gets a vault of its own unless `sameVault`: a saved login for the same site and email is reused. */
async function open(site: string, sameVault = false): Promise<Page> {
  if (!stateDir || !sameVault) { stateDir = await mkdtemp(join(tmpdir(), 'clikcode-pw-state-')); made.push(stateDir); }
  const tab = await (await browser!.newContext({ ignoreHTTPSErrors: true })).newPage();
  await tab.goto(`${base}/signup/${site}`);
  return tab;
}

/** Fill a sign-up form the way the agent does: email given, both password boxes with no text, then Create account. */
async function signUp(tab: Page): Promise<{ output: string; asked: number }> {
  let asked = 0;
  const ctx = { stateDir, acceptsImages: false, requestPrivateLogin: async () => { asked++; return undefined; } } as unknown as ToolContext;
  const result = await runSteps(tab, [{ do: 'fill', target: 'Email', text: 'ada@example.com' }, { do: 'fill', target: 'Password' }, { do: 'fill', target: 'Confirm password' }, { do: 'click', target: 'Create account' }], ctx);
  return { output: result.output, asked };
}

it.skipIf(!enabled)('reads the page policy from attributes and from hint text', async () => {
  expect(await readPasswordPolicy(await open('attrs'))).toMatchObject({ minLength: 16, maxLength: 20, length: 20 });
  expect(await readPasswordPolicy(await open('hinted'))).toMatchObject({ minLength: 8, maxLength: 16, symbols: '', length: 16 });
  expect(await readPasswordPolicy(await open('plain'))).toMatchObject({ minLength: 12, length: 24 });
});

it.skipIf(!enabled)('generates a unique password, never asks, saves the login and keeps the password out of the model view', async () => {
  const tab = await open('plain');
  const { output, asked } = await signUp(tab);
  expect(asked).toBe(0);
  expect(new URL(tab.url()).pathname).toBe('/welcome');
  expect(received.plain).toHaveLength(1);
  const password = received.plain![0]!;
  expect(password).toHaveLength(24);
  expect(output).not.toContain(password);
  expect(output).toContain('Saved the new login');
  const [login] = await savedLoginsForSite(stateDir, `${base}/`);
  expect(login!.label).toBe('ada@example.com');
  expect((await savedLoginFields(stateDir, `${base}/`, login!.id)).password).toBe(password);
  // Signing up again with the same email at the same site reuses the password that is saved for it, so a form filled twice
  // never leaves the account with a password the vault no longer has.
  await signUp(await open('plain', true));
  expect(received.plain![1]).toBe(password);
  expect(await savedLoginsForSite(stateDir, `${base}/`)).toHaveLength(1);
  // Another site gets a password of its own.
  const other = await (await browser!.newContext({ ignoreHTTPSErrors: true })).newPage();
  await other.goto(base.replace('127.0.0.1', 'localhost') + '/signup/plain');
  await signUp(other);
  expect(received.plain![2]).not.toBe(password);
  expect(received.plain![2]).toHaveLength(24);
}, 60_000);

it.skipIf(!enabled)('fits a site whose limits are only in the box attributes or hint text, without a retry', async () => {
  await signUp(await open('attrs'));
  expect(received.attrs).toHaveLength(1);
  expect(received.attrs![0]).toHaveLength(20);
  await signUp(await open('hinted'));
  expect(received.hinted).toHaveLength(1);
  expect(received.hinted![0]).toMatch(/^[A-Za-z0-9]{16}$/);
}, 60_000);

it.skipIf(!enabled)('regenerates under looser rules when the site refuses it, unseen by the model, and saves the one that worked', async () => {
  const tab = await open('strict');
  const { output } = await signUp(tab);
  expect(new URL(tab.url()).pathname).toBe('/welcome');
  const tried = received.strict!;
  expect(tried.length).toBeGreaterThanOrEqual(2);
  expect(tried.length).toBeLessThanOrEqual(4);
  expect(tried[0]).toHaveLength(24);
  expect(tried.at(-1)).toMatch(/^[A-Za-z0-9]{1,12}$/);
  for (const password of tried) expect(output).not.toContain(password);
  expect(output).toContain('refused the first generated password');
  const logins = await savedLoginsForSite(stateDir, `${base}/`);
  expect(logins).toHaveLength(1);
  expect((await savedLoginFields(stateDir, `${base}/`, logins[0]!.id)).password).toBe(tried.at(-1));
}, 60_000);

it.skipIf(!enabled)('stops after three retries when the site never accepts, and says so', async () => {
  const tab = await open('never');
  const { output } = await signUp(tab);
  expect(received.never).toHaveLength(4); // the first try and three retries
  expect(new URL(tab.url()).pathname).toBe('/signup/never');
  expect(output).toContain('refused the generated password 3 times');
  for (const password of received.never!) expect(output).not.toContain(password);
}, 60_000);

it.skipIf(!enabled)('uses the profile password only when generating is switched off', async () => {
  const tab = await open('plain');
  await setGeneratedPasswords(stateDir, false);
  const { saveProfile, saveProfileSecret } = await import('./profiles.js');
  const profile = await saveProfile(stateDir, { label: 'Personal', fields: { email: 'ada@example.com' } });
  await saveProfileSecret(stateDir, profile.id, 'password', ['Profile', 'Fallback', '12345'].join('-'));
  await signUp(tab);
  expect(received.plain).toEqual(['Profile-Fallback-12345']);
}, 60_000);

const signIn = async (askedRef: { count: number }): Promise<{ run: () => ReturnType<typeof runSteps>; tab: Page }> => {
  stateDir = await mkdtemp(join(tmpdir(), 'clikcode-pw-state-')); made.push(stateDir);
  const tab = await (await browser!.newContext({ ignoreHTTPSErrors: true })).newPage();
  await tab.goto(`${base}/signin`);
  const ctx = { stateDir, acceptsImages: false, requestPrivateLogin: async () => { askedRef.count++; return undefined; } } as unknown as ToolContext;
  return { tab, run: () => runSteps(tab, [{ do: 'fill', target: 'Email' }, { do: 'fill', target: 'Password' }], ctx) };
};

it.skipIf(!enabled)('a sign-in fill with no text uses the site\'s saved login, with no prompt and no profile password', async () => {
  const asked = { count: 0 };
  const { tab, run } = await signIn(asked);
  await saveLoginFields(stateDir, `${base}/`, { username: 'ada@example.com', password: ['Saved', 'Site', 'Pw', '991'].join('-') });
  const result = await run();
  expect(asked.count).toBe(0);
  expect(await tab.locator('input[name=email]').inputValue()).toBe('ada@example.com');
  expect(await tab.locator('input[name=pw]').inputValue()).toBe('Saved-Site-Pw-991');
  expect(result.output).not.toContain('Saved-Site-Pw-991');
}, 60_000);

it.skipIf(!enabled)('a sign-in fill with no saved login and no profile password parks with a clear note instead of failing with "did not provide"', async () => {
  const asked = { count: 0 };
  const { run } = await signIn(asked);
  const failure = await run().then(() => undefined, (error: unknown) => error as Error);
  expect(failure?.message).toContain('Parked');
  expect(failure?.message).toContain('no saved login for this site');
  expect(failure?.message).not.toContain('did not provide');
  expect(await listTasks(stateDir, { status: 'needs-human' })).toHaveLength(1);
}, 60_000);
