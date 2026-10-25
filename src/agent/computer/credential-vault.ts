/** Local encrypted login vault. Only opaque item ids cross the model boundary. */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const SESSION_MS = 10 * 60_000;
const sessions = new Map<string, { key: Buffer; expires: number }>();
export class CredentialError extends Error {}
type Item = { origin: string; fields?: Record<string, string>; rejected?: true };

function vaultDir(stateDir: string): string { return path.join(stateDir, 'computer', 'vault'); }
function keyFile(stateDir: string): string { return path.join(vaultDir(stateDir), 'vault.key'); }
function siteOrigin(url: string): string {
  try { const value = new URL(url); if (value.protocol === 'https:' && !value.username && !value.password) return value.origin; }
  catch { /* invalid URL */ }
  throw new CredentialError('Private credentials require an HTTPS website.');
}
/** Cloud providers sign users in on a regional host (us-east-2.signin.aws.amazon.com).
 * Only that leading region label is ignored when matching a saved login, so the
 * same account works whichever region the redirect picks. Nothing else is loosened. */
const REGION_LABEL = /^[a-z]{2}(?:-[a-z]+)+-\d+\./;
/** `www.` is the same site as the bare host: a login saved at example.com is found at www.example.com and back. */
const WWW_LABEL = /^www\./;
export function siteKey(url: string): string {
  const { protocol, hostname, port } = new URL(siteOrigin(url));
  return `${protocol}//${hostname.replace(REGION_LABEL, '').replace(WWW_LABEL, '')}${port ? `:${port}` : ''}`;
}
export function sameSite(a: string, b: string): boolean {
  try { return siteKey(a) === siteKey(b); } catch { return false; }
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
    // Windows reports no POSIX bits (files look 0o666), so the owner-only check is POSIX-only.
    if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw new Error();
    key = await fs.readFile(keyFile(stateDir));
  } catch { throw new CredentialError('The local login vault key is missing or not private.'); }
  if (key.length !== 32) throw new CredentialError('The local login vault key is invalid.');
  cache(stateDir, key);
  return key;
}
/** Incremental login steps, such as Gmail's email page followed by its
 * password page, use the same encrypted item. Only the local worker reads it. */
function itemFields(item: Item): Record<string, string> {
  return { ...item.fields };
}

export async function savedLoginFields(stateDir: string, url: string, id: string): Promise<Record<string, string>> {
  return itemFields(await readCredential(stateDir, url, id));
}

export async function saveLoginFields(stateDir: string, url: string, fields: Record<string, string>, id?: string): Promise<string> {
  const origin = siteOrigin(url);
  if (!Object.keys(fields).length || Object.values(fields).some(value => !value)) throw new CredentialError('Complete the visible login fields.');
  const key = await vaultKey(stateDir, true);
  // The same account saved again (a new password after a reset) replaces the old entry: two entries for one
  // account would leave a sign-in asking which of them, which no unattended agent can answer.
  const username = fields.username?.trim().toLowerCase();
  id ??= username ? (await readItems(stateDir)).find(({ item }) => sameSite(item.origin, url) && item.fields?.username?.trim().toLowerCase() === username)?.id : undefined;
  const item: Item = id ? await readCredential(stateDir, url, id) : { origin };
  const itemId = id ?? randomUUID();
  const dir = path.join(vaultDir(stateDir), 'items');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const { rejected: _worked, ...kept } = item;
  await fs.writeFile(path.join(dir, `${itemId}.json`), seal(key, `item:${itemId}`, JSON.stringify({ ...kept, fields: { ...item.fields, ...fields } })), { mode: 0o600, flag: id ? 'w' : 'wx' });
  return itemId;
}

/** The site refused this saved password. Remembered so the next sign-in asks
 * which account to use (and can take a new password) instead of resending it. */
export async function setLoginRejected(stateDir: string, url: string, id: string, rejected: boolean): Promise<void> {
  const key = await vaultKey(stateDir, false);
  const { rejected: _was, ...item } = await readCredential(stateDir, url, id);
  await fs.writeFile(path.join(vaultDir(stateDir), 'items', `${id}.json`), seal(key, `item:${id}`, JSON.stringify(rejected ? { ...item, rejected: true } : item)), { mode: 0o600 });
}

async function readCredential(stateDir: string, url: string, id: string): Promise<Item> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new CredentialError('Invalid saved login reference.');
  const key = await vaultKey(stateDir, false);
  let item: Item;
  try { item = JSON.parse(open(key, `item:${id}`, await fs.readFile(path.join(vaultDir(stateDir), 'items', `${id}.json`), 'utf8'))) as Item; }
  catch { throw new CredentialError('That saved login could not be opened.'); }
  if (!sameSite(item.origin, url)) throw new CredentialError('That saved login does not match this website.');
  return item;
}

type SavedLogin = { id: string; label: string; rejected: boolean };

/** What a person recognises a login by: its non-secret fields, never the
 * password. Shown only in the user's own picker, never to the model. */
export function loginLabel(fields: Readonly<Record<string, string>>): string {
  const order = ['accountId', 'email', 'username'];
  const keys = [...order.filter(key => fields[key]), ...Object.keys(fields).filter(key => !order.includes(key) && !/password/i.test(key) && fields[key])];
  const values = [...new Set(keys.map(key => fields[key]!))];
  return values.join(' · ') || 'Saved login';
}

async function readItems(stateDir: string): Promise<{ id: string; item: Item }[]> {
  const dir = path.join(vaultDir(stateDir), 'items');
  let files: string[];
  try { files = await fs.readdir(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new CredentialError('Saved logins could not be read.');
  }
  if (files.length === 0) return [];
  const key = await vaultKey(stateDir, false);
  const items: { id: string; item: Item }[] = [];
  for (const file of files) {
    const id = file.replace(/\.json$/, '');
    if (!/^[0-9a-f-]{36}$/i.test(id) || file !== `${id}.json`) continue;
    try { items.push({ id, item: JSON.parse(open(key, `item:${id}`, await fs.readFile(path.join(dir, file), 'utf8'))) as Item }); }
    catch { throw new CredentialError('A saved login could not be opened.'); }
  }
  return items;
}

const byLabel = <T extends { label: string; id: string }>(a: T, b: T): number => a.label.localeCompare(b.label) || a.id.localeCompare(b.id);

/** Every login saved for this site, in a stable order. */
export async function savedLoginsForSite(stateDir: string, url: string): Promise<SavedLogin[]> {
  siteOrigin(url);
  return (await readItems(stateDir))
    .filter(({ item }) => sameSite(item.origin, url))
    .map(({ id, item }) => ({ id, label: loginLabel(itemFields(item)), rejected: item.rejected === true }))
    .sort(byLabel);
}

/** Every saved login on every site, for the user's own review. */
export async function allSavedLogins(stateDir: string): Promise<{ id: string; site: string; label: string }[]> {
  return (await readItems(stateDir))
    .map(({ id, item }) => ({ id, site: new URL(item.origin).hostname, label: loginLabel(itemFields(item)) }))
    .sort((a, b) => a.site.localeCompare(b.site) || byLabel(a, b));
}

/** A site given as a host ("wordnik.com") or a URL. */
function siteUrl(site: string): string {
  const value = site.trim();
  if (!value) throw new CredentialError('Name the site whose saved login to remove.');
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

/** Remove the saved logins for one site, or only the one account whose label (username or email) matches.
 * Returns how many were removed; the labels stay out of the result. */
export async function forgetSavedLogins(stateDir: string, site: string, label?: string): Promise<number> {
  const url = siteUrl(site);
  siteOrigin(url);
  const wanted = label?.trim().toLowerCase();
  let removed = 0;
  for (const login of await savedLoginsForSite(stateDir, url)) {
    if (wanted && login.label.toLowerCase() !== wanted && !login.label.toLowerCase().split(' · ').includes(wanted)) continue;
    if (await removeSavedLogin(stateDir, login.id)) removed++;
  }
  return removed;
}

export async function removeSavedLogin(stateDir: string, id: string): Promise<boolean> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new CredentialError('Invalid saved login reference.');
  try { await fs.unlink(path.join(vaultDir(stateDir), 'items', `${id}.json`)); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw new CredentialError('The saved login could not be removed.'); }
}

/** Named secrets (API keys) captured from a page or pasted by the user. They
 * live beside the saved logins under the same key, and only the worker reads
 * them back: the agent works with the name alone. */
const SECRET_NAME = /^[a-z0-9][a-z0-9._/-]{0,63}$/i;
function secretFile(stateDir: string, name: string): { file: string; aad: string } {
  if (!SECRET_NAME.test(name)) throw new CredentialError('A secret name uses letters, digits, dot, dash, underscore or slash, up to 64 characters.');
  const hash = createHash('sha256').update(name.toLowerCase()).digest('hex').slice(0, 32);
  return { file: path.join(vaultDir(stateDir), 'secrets', `${hash}.json`), aad: `secret:${hash}` };
}
/** What a secret is for and who owns it, kept beside the value so a long list of credentials can be audited and rotated. */
export type SecretMeta = { vendor?: string; owner?: string; env?: string; createdAt: string; rotatedAt?: string };
export async function saveNamedSecret(stateDir: string, name: string, value: string, meta: { vendor?: string; owner?: string; env?: string } = {}): Promise<void> {
  if (!value) throw new CredentialError('The secret is empty.');
  const { file, aad } = secretFile(stateDir, name);
  const key = await vaultKey(stateDir, true);
  // A second save of the same name is a rotation: the first date stays, and what was given before stays unless given again.
  let before: { value?: string; meta?: SecretMeta } = {};
  try { before = JSON.parse(open(key, aad, await fs.readFile(file, 'utf8'))) as typeof before; } catch { /* a new secret */ }
  // A secret saved before records existed was made when its file was.
  if (before.value !== undefined && !before.meta) { const made = await fs.stat(file).then(info => info.mtime.toISOString(), () => undefined); if (made) before.meta = { createdAt: made }; }
  const now = new Date().toISOString();
  const kept = (field: 'vendor' | 'owner' | 'env'): Partial<SecretMeta> => { const v = meta[field]?.trim() || before.meta?.[field]; return v ? { [field]: v } : {}; };
  const saved: SecretMeta = { ...kept('vendor'), ...kept('owner'), ...kept('env'), createdAt: before.meta?.createdAt ?? now, ...(before.value !== undefined && before.value !== value ? { rotatedAt: now } : before.meta?.rotatedAt ? { rotatedAt: before.meta.rotatedAt } : {}) };
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, seal(key, aad, JSON.stringify({ name, value, meta: saved })), { mode: 0o600 });
}
/** Names with their records, never the values. */
export async function namedSecretInfo(stateDir: string): Promise<{ name: string; meta?: SecretMeta }[]> {
  const dir = path.join(vaultDir(stateDir), 'secrets');
  let files: string[];
  try { files = await fs.readdir(dir); } catch { return []; }
  const key = await vaultKey(stateDir, false);
  const out: { name: string; meta?: SecretMeta }[] = [];
  for (const file of files) {
    try { const { name, meta } = JSON.parse(open(key, `secret:${file.replace(/\.json$/, '')}`, await fs.readFile(path.join(dir, file), 'utf8'))) as { name: string; meta?: SecretMeta }; out.push({ name, ...(meta ? { meta } : {}) }); }
    catch { /* an unreadable file is skipped, never shown */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
export async function readNamedSecret(stateDir: string, name: string): Promise<string> {
  const { file, aad } = secretFile(stateDir, name);
  const key = await vaultKey(stateDir, false);
  try { return (JSON.parse(open(key, aad, await fs.readFile(file, 'utf8'))) as { value: string }).value; }
  catch { throw new CredentialError(`No secret named "${name}" is saved.`); }
}
export async function namedSecretNames(stateDir: string): Promise<string[]> {
  const dir = path.join(vaultDir(stateDir), 'secrets');
  let files: string[];
  try { files = await fs.readdir(dir); } catch { return []; }
  const key = await vaultKey(stateDir, false);
  const names: string[] = [];
  for (const file of files) {
    try { names.push((JSON.parse(open(key, `secret:${file.replace(/\.json$/, '')}`, await fs.readFile(path.join(dir, file), 'utf8'))) as { name: string }).name); }
    catch { /* an unreadable file is skipped, never shown */ }
  }
  return names.sort();
}

export async function deleteNamedSecret(stateDir: string, name: string): Promise<boolean> {
  const { file } = secretFile(stateDir, name);
  try { await fs.unlink(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw new CredentialError('The secret could not be removed.'); }
}

/** Other sealed records that live in the vault (autofill profiles): one encrypted file each, under the same key. */
const RECORD_FOLDER = /^[a-z][a-z-]{1,30}$/;
export async function writeVaultRecord(stateDir: string, folder: string, id: string, value: object): Promise<void> {
  if (!RECORD_FOLDER.test(folder) || !/^[0-9a-f-]{36}$/i.test(id)) throw new CredentialError('Invalid vault record.');
  const key = await vaultKey(stateDir, true);
  const dir = path.join(vaultDir(stateDir), folder);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(dir, `${id}.json`), seal(key, `${folder}:${id}`, JSON.stringify(value)), { mode: 0o600 });
}
export async function readVaultRecords<T>(stateDir: string, folder: string): Promise<{ id: string; value: T }[]> {
  if (!RECORD_FOLDER.test(folder)) throw new CredentialError('Invalid vault record.');
  const dir = path.join(vaultDir(stateDir), folder);
  let files: string[];
  try { files = await fs.readdir(dir); } catch { return []; }
  if (!files.length) return [];
  const key = await vaultKey(stateDir, false);
  const out: { id: string; value: T }[] = [];
  for (const file of files) {
    const id = file.replace(/\.json$/, '');
    if (!/^[0-9a-f-]{36}$/i.test(id) || file !== `${id}.json`) continue;
    try { out.push({ id, value: JSON.parse(open(key, `${folder}:${id}`, await fs.readFile(path.join(dir, file), 'utf8'))) as T }); }
    catch { /* an unreadable record is skipped, never shown */ }
  }
  return out;
}
export async function removeVaultRecord(stateDir: string, folder: string, id: string): Promise<boolean> {
  if (!RECORD_FOLDER.test(folder) || !/^[0-9a-f-]{36}$/i.test(id)) throw new CredentialError('Invalid vault record.');
  try { await fs.unlink(path.join(vaultDir(stateDir), folder, `${id}.json`)); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw new CredentialError('The record could not be removed.'); }
}

/** Gives every secret saved before records existed a vendor (the first part of its name, "netlify/client-id" is netlify). The value is untouched and never leaves this file. */
export async function backfillSecretMeta(stateDir: string, owner?: string): Promise<string[]> {
  const done: string[] = [];
  for (const { name, meta } of await namedSecretInfo(stateDir)) {
    const vendor = name.includes('/') ? name.split('/')[0] : undefined;
    if ((meta?.vendor || !vendor) && (meta?.owner || !owner)) continue;
    await saveNamedSecret(stateDir, name, await readNamedSecret(stateDir, name), { ...(vendor && !meta?.vendor ? { vendor } : {}), ...(owner && !meta?.owner ? { owner } : {}) });
    done.push(name);
  }
  return done;
}

/** Everything in the vault in the clear, for an encrypted backup (see vault-backup.ts). Never leaves this process unencrypted. */
export type VaultSnapshot = {
  v: 1;
  items: { id: string; item: Item }[];
  secrets: { name: string; value: string; meta?: SecretMeta }[];
  records: { folder: string; id: string; value: unknown }[];
};

export async function snapshotVault(stateDir: string): Promise<VaultSnapshot> {
  const items = await readItems(stateDir);
  const key = await vaultKey(stateDir, false).catch(() => undefined);
  const secrets: VaultSnapshot['secrets'] = [];
  const dir = path.join(vaultDir(stateDir), 'secrets');
  for (const file of key ? await fs.readdir(dir).catch(() => [] as string[]) : []) {
    try { secrets.push(JSON.parse(open(key!, `secret:${file.replace(/\.json$/, '')}`, await fs.readFile(path.join(dir, file), 'utf8'))) as VaultSnapshot['secrets'][number]); }
    catch { /* an unreadable file is left out of the backup, as it is out of every list */ }
  }
  const records: VaultSnapshot['records'] = [];
  for (const entry of await fs.readdir(vaultDir(stateDir), { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.name === 'items' || entry.name === 'secrets' || !RECORD_FOLDER.test(entry.name)) continue;
    for (const { id, value } of await readVaultRecords<unknown>(stateDir, entry.name)) records.push({ folder: entry.name, id, value });
  }
  return { v: 1, items, secrets, records };
}

/** Puts a snapshot into this vault (making its key if there is none). What is already here is kept unless `overwrite`. */
export async function restoreVault(stateDir: string, snapshot: VaultSnapshot, options: { overwrite?: boolean } = {}): Promise<{ added: number; skipped: number }> {
  if (snapshot?.v !== 1 || !Array.isArray(snapshot.items) || !Array.isArray(snapshot.secrets) || !Array.isArray(snapshot.records)) throw new CredentialError('That is not a ClikCode vault backup.');
  const key = await vaultKey(stateDir, true);
  let added = 0; let skipped = 0;
  const put = async (file: string, aad: string, value: unknown): Promise<void> => {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    try { await fs.writeFile(file, seal(key, aad, JSON.stringify(value)), { mode: 0o600, flag: options.overwrite ? 'w' : 'wx' }); added++; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') skipped++; else throw error; }
  };
  for (const { id, item } of snapshot.items) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) continue;
    await put(path.join(vaultDir(stateDir), 'items', `${id}.json`), `item:${id}`, item);
  }
  for (const secret of snapshot.secrets) {
    const { file, aad } = secretFile(stateDir, secret.name);
    await put(file, aad, secret);
  }
  for (const { folder, id, value } of snapshot.records) {
    if (!RECORD_FOLDER.test(folder) || folder === 'items' || folder === 'secrets' || !/^[0-9a-f-]{36}$/i.test(id)) continue;
    await put(path.join(vaultDir(stateDir), folder, `${id}.json`), `${folder}:${id}`, value);
  }
  return { added, skipped };
}
