/** Local encrypted login vault. Only opaque item ids cross the model boundary. */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { protectLoginPage } from './private-page.js';

const SESSION_MS = 10 * 60_000;
const sessions = new Map<string, { key: Buffer; expires: number }>();
export class CredentialError extends Error {}
type Item = { origin: string; accountId: string; email: string; password: string };

function vaultDir(stateDir: string): string { return path.join(stateDir, 'computer', 'vault'); }
function keyFile(stateDir: string): string { return path.join(vaultDir(stateDir), 'vault.key'); }
function siteOrigin(url: string): string {
  try { const value = new URL(url); if (value.protocol === 'https:' && !value.username && !value.password) return value.origin; }
  catch { /* invalid URL */ }
  throw new CredentialError('Private credentials require an HTTPS website.');
}
function seal(key: Buffer, aad: string, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  return Buffer.concat([iv, cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64url');
}
function open(key: Buffer, aad: string, packet: string): string {
  try {
    const bytes = Buffer.from(packet, 'base64url');
    if (bytes.length < 29) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8');
  } catch { throw new CredentialError('The saved login could not be decrypted.'); }
}
function cache(stateDir: string, key: Buffer): void {
  lockCredentialVault(stateDir);
  sessions.set(stateDir, { key, expires: Date.now() + SESSION_MS });
}
function currentKey(stateDir: string): Buffer | undefined {
  const session = sessions.get(stateDir);
  if (!session) return undefined;
  if (session.expires <= Date.now()) { lockCredentialVault(stateDir); return undefined; }
  return session.key;
}
export function lockCredentialVault(stateDir: string): void {
  sessions.get(stateDir)?.key.fill(0);
  sessions.delete(stateDir);
}
async function vaultKey(stateDir: string, create: boolean): Promise<Buffer> {
  const cached = currentKey(stateDir);
  if (cached) return cached;
  const dir = vaultDir(stateDir);
  if (create) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const generated = randomBytes(32);
    try { await fs.writeFile(keyFile(stateDir), generated, { mode: 0o600, flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new CredentialError('The local login vault could not be opened.'); }
    finally { generated.fill(0); }
  }
  let key: Buffer;
  try {
    const info = await fs.lstat(keyFile(stateDir));
    if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error();
    key = await fs.readFile(keyFile(stateDir));
  } catch { throw new CredentialError('The local login vault key is missing or not private.'); }
  if (key.length !== 32) throw new CredentialError('The local login vault key is invalid.');
  cache(stateDir, key);
  return key;
}
export async function saveCredential(stateDir: string, url: string, secret: Omit<Item, 'origin'>): Promise<string> {
  const origin = siteOrigin(url);
  if (!secret.email && !secret.accountId || !secret.password) throw new CredentialError('Enter an email or account ID and a password.');
  const key = await vaultKey(stateDir, true);
  const id = randomUUID();
  const dir = path.join(vaultDir(stateDir), 'items');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(dir, `${id}.json`), seal(key, `item:${id}`, JSON.stringify({ origin, accountId: secret.accountId, email: secret.email, password: secret.password })), { mode: 0o600, flag: 'wx' });
  return id;
}

/** Reuse a saved login only when this site has exactly one. Never guess which
 * account the user wants when several are saved for the same origin. */
export async function soleCredentialForSite(stateDir: string, url: string): Promise<string | undefined> {
  const origin = siteOrigin(url);
  const dir = path.join(vaultDir(stateDir), 'items');
  let files: string[];
  try { files = await fs.readdir(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new CredentialError('Saved logins could not be read.');
  }
  if (files.length === 0) return undefined;
  const key = await vaultKey(stateDir, false);
  const matches: string[] = [];
  for (const file of files) {
    const id = file.replace(/\.json$/, '');
    if (!/^[0-9a-f-]{36}$/i.test(id) || file !== `${id}.json`) continue;
    try {
      const item = JSON.parse(open(key, `item:${id}`, await fs.readFile(path.join(dir, file), 'utf8'))) as Item;
      if (item.origin === origin) matches.push(id);
    } catch { throw new CredentialError('A saved login could not be opened.'); }
  }
  return matches.length === 1 ? matches[0] : undefined;
}
export async function fillCredential(stateDir: string, page: Page, id: string): Promise<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new CredentialError('Invalid saved login reference.');
  const origin = siteOrigin(page.url());
  const key = await vaultKey(stateDir, false);
  let item: Item;
  try { item = JSON.parse(open(key, `item:${id}`, await fs.readFile(path.join(vaultDir(stateDir), 'items', `${id}.json`), 'utf8'))) as Item; }
  catch { throw new CredentialError('That saved login could not be opened.'); }
  if (item.origin !== origin || !item.password) throw new CredentialError('That saved login does not match this website.');
  protectLoginPage(page);
  for (let step = 0; step < 4; step++) {
    if (siteOrigin(page.url()) !== origin) throw new CredentialError('The login moved to another website. Use the phone handoff.');
    const password = page.locator('input[type="password"]:visible');
    const account = page.getByRole('textbox', { name: /account id|account alias/i });
    const username = page.locator('input[autocomplete="username"]:visible, input[type="email"]:visible');
    const namedUsername = page.getByRole('textbox', { name: /email|username/i });
    let next: { fill(value: string): Promise<void>; press(key: string): Promise<void> } | undefined;
    if (item.email && await username.count() === 1) { await username.fill(item.email); next = username; }
    else if (item.email && await namedUsername.count() === 1) { await namedUsername.fill(item.email); next = namedUsername; }
    if (item.accountId && await account.count() === 1) { await account.fill(item.accountId); next = account; }
    if (await password.count() === 1) { await password.fill(item.password); return; }
    if (!next) throw new CredentialError('No matching login field is visible. Use the phone handoff.');
    await next.press('Enter');
    await page.waitForTimeout(750);
  }
  throw new CredentialError('The website needs more login steps. Use the phone handoff.');
}
