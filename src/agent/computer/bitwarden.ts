/** The model receives item ids and status only. Plaintext stays in this local
 * adapter and Bitwarden's CLI, never in a tool argument, event, or result. */
import { spawn } from 'node:child_process';
import type { Page } from 'playwright-core';
import { protectLoginPage } from './private-page.js';

export type PrivateCredential = { accountId: string; email: string; password: string; vaultPassword: string };
type VaultItem = { id: string; login?: { username?: string; password?: string; uris?: Array<{ uri?: string }> }; fields?: Array<{ name?: string; value?: string }> };
const sessions = new Map<string, { key: string; expires: number }>();
const SESSION_MS = 10 * 60_000;
export class CredentialError extends Error {}

function parsed<T>(text: string): T {
  try { return JSON.parse(text) as T; }
  catch { throw new CredentialError('Bitwarden returned an invalid response.'); }
}

function siteOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) return parsed.origin;
  } catch { /* invalid URL */ }
  throw new CredentialError('Private credentials require an HTTPS website.');
}

async function bw(args: string[], env: Record<string, string> = {}, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('bw', args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    const out: Buffer[] = [];
    let size = 0;
    child.stdout.on('data', (data: Buffer) => {
      size += data.length;
      if (size <= 2_000_000) out.push(data);
      else child.kill();
    });
    // CLI errors may echo input. Never put stderr in a model-visible error.
    child.stderr.resume();
    child.on('error', (error: NodeJS.ErrnoException) => reject(error.code === 'ENOENT'
      ? new CredentialError('Install the official Bitwarden CLI (bw) on this computer first.')
      : new CredentialError('Bitwarden could not start.')));
    child.on('close', (code) => code === 0 && size <= 2_000_000
      ? resolve(Buffer.concat(out).toString('utf8'))
      : reject(new CredentialError('Bitwarden did not complete this operation. Check that its CLI is signed in and the vault password is correct.')));
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

async function sessionFor(stateDir: string, vaultPassword = ''): Promise<string> {
  const cached = sessions.get(stateDir);
  if (cached && cached.expires > Date.now()) return cached.key;
  if (cached) sessions.delete(stateDir);
  if (process.env.BW_SESSION) return process.env.BW_SESSION;
  if (!vaultPassword) throw new CredentialError('Unlock Bitwarden in the private form to use this login.');
  const status = parsed<{ status?: string }>(await bw(['status']));
  if (status.status === 'unauthenticated') throw new CredentialError('Sign in to the Bitwarden CLI once on this computer, then retry.');
  if (status.status !== 'locked' && status.status !== 'unlocked') throw new CredentialError('Bitwarden CLI status is unavailable.');
  const key = (await bw(['unlock', '--raw', '--passwordenv', 'CLIKCODE_PRIVATE_BW_PASSWORD'],
    { CLIKCODE_PRIVATE_BW_PASSWORD: vaultPassword })).trim();
  if (!key) throw new CredentialError('Bitwarden did not unlock.');
  sessions.set(stateDir, { key, expires: Date.now() + SESSION_MS });
  return key;
}

export function bitwardenSessionReady(stateDir: string): boolean {
  const cached = sessions.get(stateDir);
  return !!process.env.BW_SESSION || !!(cached && cached.expires > Date.now());
}

export async function unlockBitwarden(stateDir: string, vaultPassword: string): Promise<void> {
  await sessionFor(stateDir, vaultPassword);
}

export async function bitwardenReady(): Promise<void> {
  const status = parsed<{ status?: string }>(await bw(['status']));
  if (status.status === 'unauthenticated') throw new CredentialError('Sign in to the Bitwarden CLI once on this computer, then retry.');
  if (status.status !== 'locked' && status.status !== 'unlocked') throw new CredentialError('Bitwarden CLI status is unavailable.');
}

/** Called only by the encrypted user-input receiver, never with model args. */
export async function saveBitwardenCredential(stateDir: string, url: string, secret: PrivateCredential): Promise<string> {
  const origin = siteOrigin(url);
  const username = secret.email || secret.accountId;
  if (!username || !secret.password) throw new CredentialError('Enter an email or account ID and a password.');
  const session = await sessionFor(stateDir, secret.vaultPassword);
  const template = parsed<Record<string, unknown>>(await bw(['get', 'template', 'item'], { BW_SESSION: session }));
  const login = parsed<Record<string, unknown>>(await bw(['get', 'template', 'item.login'], { BW_SESSION: session }));
  const item = {
    ...template, type: 1, name: new URL(origin).hostname, login: { ...login, username, password: secret.password,
      uris: [{ uri: origin, match: 1 }] },
    fields: [
      ...(secret.accountId ? [{ name: 'Account ID', value: secret.accountId, type: 0 }] : []),
      ...(secret.email ? [{ name: 'Email', value: secret.email, type: 0 }] : []),
    ],
  };
  const encoded = Buffer.from(JSON.stringify(item)).toString('base64');
  const created = parsed<{ id?: string }>(await bw(['create', 'item'], { BW_SESSION: session }, encoded));
  if (!created.id || !/^[0-9a-f-]{36}$/i.test(created.id)) throw new CredentialError('Bitwarden did not return an item reference.');
  return created.id;
}

/** The site is checked again at fill time; an item id alone authorizes nothing. */
export async function fillBitwardenCredential(stateDir: string, page: Page, id: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new CredentialError('Invalid Bitwarden item reference.');
  const origin = siteOrigin(page.url());
  const session = await sessionFor(stateDir);
  const item = parsed<VaultItem>(await bw(['get', 'item', id], { BW_SESSION: session }));
  if (item.id !== id || !item.login?.password || !item.login.uris?.some((entry) => {
    try { return siteOrigin(entry.uri ?? '') === origin; } catch { return false; }
  })) throw new CredentialError('That Bitwarden item does not match this website.');
  protectLoginPage(page);
  const accountId = item.fields?.find((field) => field.name === 'Account ID')?.value;
  for (let step = 0; step < 4; step++) {
    if (siteOrigin(page.url()) !== origin) throw new CredentialError('The login moved to another website. Use the phone handoff.');
    const password = page.locator('input[type="password"]:visible');
    const account = page.getByRole('textbox', { name: /account id|account alias/i });
    const username = page.locator('input[autocomplete="username"]:visible, input[type="email"]:visible');
    const namedUsername = page.getByRole('textbox', { name: /email|username/i });
    let next: { fill(value: string): Promise<void>; press(key: string): Promise<void> } | undefined;
    if (item.login.username && await username.count() === 1) { await username.fill(item.login.username); next = username; }
    else if (item.login.username && await namedUsername.count() === 1) { await namedUsername.fill(item.login.username); next = namedUsername; }
    if (accountId && await account.count() === 1) { await account.fill(accountId); next = account; }
    if (await password.count() === 1) { await password.fill(item.login.password); return; }
    if (!next) throw new CredentialError('No matching login field is visible. Use the phone handoff.');
    await next.press('Enter');
    await page.waitForTimeout(750);
  }
  throw new CredentialError('The website needs more login steps. Use the phone handoff.');
}

export function forgetBitwardenSession(stateDir: string): void { sessions.delete(stateDir); }
