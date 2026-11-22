/** Local encrypted login vault. Only opaque item ids cross the model boundary. */
import { quiet, swallowed } from '../../runtime/lifecycle-log.js';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from '../../session/store/files.js';
import { withFileLock } from '../../session/store/locks.js';

const SESSION_MS = 10 * 60_000;
const sessions = new Map<string, { key: Buffer; expires: number }>();
export class CredentialError extends Error {}
/** A saved sign-in: the site's base URL (`origin`), a name for it, how it signs in (`method`: `password`, or the provider an OAuth sign-in
 * went through, such as `google`), and the account's fields. `name` and `method` are worked out when an older record has none. */
type Item = { origin: string; name?: string; method?: string; fields?: Record<string, string>; rejected?: true };

function vaultDir(stateDir: string): string { return path.join(stateDir, 'computer', 'vault'); }
function keyFile(stateDir: string): string { return path.join(vaultDir(stateDir), 'vault.key'); }
function siteOrigin(url: string): string {
  try { const value = new URL(url); if (value.protocol === 'https:' && !value.username && !value.password) return value.origin; }
  catch { /* fail-open-ok: invalid URL */ }
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
/** Every read-modify-write of the vault holds this lock, so two processes (a worker, the CLI, a sync's remote end) never lose
 * each other's change. Not re-entrant: the public writers take it, the `...Held` helpers they share assume it. */
async function withVaultLock<T>(stateDir: string, run: () => Promise<T>): Promise<T> {
  await fs.mkdir(vaultDir(stateDir), { recursive: true, mode: 0o700 });
  return withFileLock(path.join(vaultDir(stateDir), 'write.lock'), run);
}
/** A sealed file written whole or not at all (temp file, fsync, rename): a crash or a reader mid-write never sees half of one.
 * `exclusive`: refuse (EEXIST) when the file is already there -- checked under the vault lock, so it cannot race another writer. */
async function writeSealed(file: string, data: string, options: { exclusive?: boolean } = {}): Promise<void> {
  if (options.exclusive && await fs.lstat(file).then(() => true, () => false)) throw Object.assign(new Error(`${path.basename(file)} exists`), { code: 'EEXIST' });
  await atomicWriteFile(file, data, { mode: 0o600 });
}
/** A vault file that is a record, not a temporary of an atomic write or the lock. */
const isRecordFile = (file: string): boolean => file.endsWith('.json');

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

const TWO_PART_TLD = /^(?:co|com|org|net|gov|ac|edu)\.[a-z]{2}$/;
/** What to call a site: its own name, not the part of the address around it (login.wordnik.com is Wordnik, app.kit.com is Kit). */
export function siteName(urlOrOrigin: string): string {
  let host = '';
  try { host = new URL(urlOrOrigin).hostname.replace(/^www\./, ''); } catch { return urlOrOrigin; }
  const labels = host.split('.');
  const tail = labels.slice(-2).join('.');
  const own = labels.length >= 3 && TWO_PART_TLD.test(tail) ? labels.at(-3)! : labels.length >= 2 ? labels.at(-2)! : labels[0]!;
  return own.charAt(0).toUpperCase() + own.slice(1);
}

interface LoginRecord { id: string; name: string; site: string; method: string; account: string; complete: boolean; rejected: boolean }
function loginRecord(id: string, item: Item): LoginRecord {
  const fields = itemFields(item);
  const method = item.method ?? (fields.password ? 'password' : 'unknown');
  const identified = Boolean(fields.email || fields.username || fields.accountId);
  return { id, name: item.name ?? siteName(item.origin), site: item.origin, method, account: loginLabel(fields), complete: identified && (method !== 'password' || Boolean(fields.password)), rejected: item.rejected === true };
}

export async function savedLoginFields(stateDir: string, url: string, id: string): Promise<Record<string, string>> {
  return itemFields(await readCredential(stateDir, url, id));
}

/** The username a sign-up's login carries until its email is seen. Every such entry is its own account: never matched to another. */
export const UNKNOWN_ACCOUNT = '(email not captured)';

export async function saveLoginFields(stateDir: string, url: string, fields: Record<string, string>, id?: string, extra: { name?: string; method?: string } = {}): Promise<string> {
  const origin = siteOrigin(url);
  if (!Object.keys(fields).length || Object.values(fields).some(value => !value)) throw new CredentialError('Complete the visible login fields.');
  return withVaultLock(stateDir, () => saveLoginFieldsHeld(stateDir, url, origin, fields, id, extra));
}
async function saveLoginFieldsHeld(stateDir: string, url: string, origin: string, fields: Record<string, string>, id: string | undefined, extra: { name?: string; method?: string }): Promise<string> {
  const key = await vaultKey(stateDir, true);
  // The same account saved again (a new password after a reset) replaces the old entry: two entries for one
  // account would leave a sign-in asking which of them, which no unattended agent can answer. A sign-up whose email
  // is not known yet is not "the same account" as another one: each keeps its own entry.
  const username = fields.username?.trim().toLowerCase();
  id ??= username && username !== UNKNOWN_ACCOUNT ? (await readItems(stateDir)).find(({ item }) => sameSite(item.origin, url) && item.fields?.username?.trim().toLowerCase() === username)?.id : undefined;
  const item: Item = id ? await readCredential(stateDir, url, id) : { origin };
  const method = extra.method ?? item.method ?? (fields.password || item.fields?.password ? 'password' : undefined);
  const itemId = id ?? randomUUID();
  const dir = path.join(vaultDir(stateDir), 'items');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const { rejected: _worked, ...kept } = item;
  await writeSealed(path.join(dir, `${itemId}.json`), seal(key, `item:${itemId}`, JSON.stringify({ ...kept, name: extra.name ?? kept.name ?? siteName(origin), ...(method ? { method } : {}), fields: { ...item.fields, ...fields } })), { exclusive: !id });
  return itemId;
}

/** The site refused this saved password. Remembered so the next sign-in asks
 * which account to use (and can take a new password) instead of resending it. */
export async function setLoginRejected(stateDir: string, url: string, id: string, rejected: boolean): Promise<void> {
  await withVaultLock(stateDir, async () => {
    const key = await vaultKey(stateDir, false);
    const { rejected: _was, ...item } = await readCredential(stateDir, url, id);
    await writeSealed(path.join(vaultDir(stateDir), 'items', `${id}.json`), seal(key, `item:${id}`, JSON.stringify(rejected ? { ...item, rejected: true } : item)));
  });
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

type SavedLogin = { id: string; label: string; rejected: boolean; usable: boolean };

/** What a person recognises a login by: its non-secret fields, never the
 * password. Shown only in the user's own picker, never to the model. */
export function loginLabel(fields: Readonly<Record<string, string>>): string {
  const order = ['accountId', 'email', 'username'];
  const keys = [...order.filter(key => fields[key]), ...Object.keys(fields).filter(key => !order.includes(key) && !/password/i.test(key) && fields[key])];
  const values = [...new Set(keys.map(key => fields[key]!))];
  return values.join(' · ') || 'Saved login';
}

/** Saved logins that could not be opened on the last read (a damaged or foreign file), by id: skipped, never fatal, and said in the audit. */
const unreadableItems = new Map<string, Set<string>>();
export const unreadableLoginIds = (stateDir: string): string[] => [...(unreadableItems.get(stateDir) ?? [])].sort();

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
  const unreadable = new Set<string>();
  for (const file of files) {
    const id = file.replace(/\.json$/, '');
    if (!/^[0-9a-f-]{36}$/i.test(id) || file !== `${id}.json`) continue;
    // One damaged entry must not hide every other login: it is skipped and reported (auditVault), never shown.
    try { items.push({ id, item: JSON.parse(open(key, `item:${id}`, await fs.readFile(path.join(dir, file), 'utf8'))) as Item }); }
    catch (error) { unreadable.add(id); swallowed('agent/computer/credential-vault', error); }
  }
  if (unreadable.size) unreadableItems.set(stateDir, unreadable); else unreadableItems.delete(stateDir);
  return items;
}

const byLabel = <T extends { label: string; id: string }>(a: T, b: T): number => a.label.localeCompare(b.label) || a.id.localeCompare(b.id);

/** Every login saved for this site, in a stable order. */
export async function savedLoginsForSite(stateDir: string, url: string): Promise<SavedLogin[]> {
  siteOrigin(url);
  return (await readItems(stateDir))
    .filter(({ item }) => sameSite(item.origin, url))
    .map(({ id, item }) => ({ id, label: loginLabel(itemFields(item)), rejected: item.rejected === true, usable: Boolean(itemFields(item).password) }))
    .sort(byLabel);
}

/** Every saved login on every site, for the user's own review (and for an agent to see which accounts exist: never a password). */
export async function allSavedLogins(stateDir: string): Promise<{ id: string; site: string; label: string; name: string; baseUrl: string; method: string; complete: boolean }[]> {
  return (await readItems(stateDir))
    .map(({ id, item }) => { const record = loginRecord(id, item); return { id, site: new URL(item.origin).hostname, label: record.account, name: record.name, baseUrl: record.site, method: record.method, complete: record.complete }; })
    .sort((a, b) => a.site.localeCompare(b.site) || byLabel(a, b));
}

/** Records that a site was signed in to through a provider (`google`, `github`, ...) as this account, so the way in is known the next time.
 * The password, if any, is the provider's own saved login. */
export async function saveSignInMethod(stateDir: string, url: string, method: string, account: string, name?: string): Promise<string> {
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(method) || method === 'password') throw new CredentialError('Name the provider the sign-in went through, such as google or github.');
  if (!account.trim()) throw new CredentialError('Say which account was used.');
  return saveLoginFields(stateDir, url, { email: account.trim() }, undefined, { method, ...(name ? { name } : {}) });
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
/** The same key written the ways agents write it ("acme/api-key", "www.acme.com/key", "Acme/secret-key") has one canonical form, so a name that
 * differs only by spelling still finds the secret, and a second save updates it instead of leaving a twin. `admin-key` and `sandbox-key` stay themselves. */
const KIND_ALIASES: Record<string, string> = {
  'api-key': 'key', apikey: 'key', 'api_key': 'key', 'secret-key': 'key', 'secret': 'key',
  'api-token': 'token', 'access-token': 'token', 'auth-token': 'token',
  clientid: 'client-id', 'client_id': 'client-id', clientsecret: 'client-secret', 'client_secret': 'client-secret',
};
export function canonicalSecretName(name: string): string {
  const lower = name.trim().toLowerCase();
  const slash = lower.indexOf('/');
  if (slash < 0) return lower;
  const vendor = lower.slice(0, slash).replace(/^www\./, '');
  const kind = lower.slice(slash + 1);
  return `${vendor}/${KIND_ALIASES[kind] ?? kind}`;
}
/** The saved name a given name means: itself when it exists, else the one saved secret with the same canonical form. */
async function savedNameFor(stateDir: string, name: string): Promise<string | undefined> {
  const names = await namedSecretNames(stateDir).catch(() => [] as string[]);
  const exact = names.find(saved => saved.toLowerCase() === name.trim().toLowerCase());
  if (exact) return exact;
  const same = names.filter(saved => canonicalSecretName(saved) === canonicalSecretName(name));
  return same.length === 1 ? same[0] : undefined;
}
/** Names that share a vendor with a missing one, for the error: names only, never values. */
async function nearNames(stateDir: string, name: string): Promise<string[]> {
  const vendor = canonicalSecretName(name).split('/')[0];
  return (await namedSecretNames(stateDir).catch(() => [] as string[])).filter(saved => canonicalSecretName(saved).split('/')[0] === vendor).slice(0, 8);
}

/** What a secret is for and who owns it, kept beside the value so a long list of credentials can be audited and rotated. */
type SecretMeta = { vendor?: string; owner?: string; env?: string; url?: string; /** The page a captured key was taken from (no query): where such a key is made. */ page?: string; createdAt: string; rotatedAt?: string };
/** A website's base URL (https, or http for a local test page); nothing else, and never with a login in it. */
function webOrigin(value: string | undefined): string | undefined {
  try { const url = new URL(value ?? ''); return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.origin : undefined; } catch { return undefined; }
}
/** Secrets the program keeps for itself (profile answers, the mailbox) have no website. Every other key must say which site it is for. */
const INTERNAL_SECRET = /^(?:profile|email)\//i;
/** The base URL a key is for: given, else the one it had, else the host in its name (app.mailgun.com/key), else the site of the one saved login for its vendor. */
async function baseUrlFor(stateDir: string, name: string, given: string | undefined, before: string | undefined): Promise<string | undefined> {
  for (const candidate of [given, before]) { const origin = webOrigin(candidate); if (origin) return origin; }
  const first = name.split('/')[0]!;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(first)) return `https://${first.toLowerCase()}`;
  const vendor = first.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (vendor.length < 3) return undefined;
  const sites = new Set((await readItems(stateDir).catch(() => [])).map(({ item }) => item.origin).filter(origin => new URL(origin).hostname.toLowerCase().replace(/[^a-z0-9]/g, '').includes(vendor)));
  return sites.size === 1 ? [...sites][0] : undefined;
}
type SecretInput = { vendor?: string; owner?: string; env?: string; url?: string; page?: string };
export async function saveNamedSecret(stateDir: string, name: string, value: string, meta: SecretInput = {}, options: { legacy?: boolean } = {}): Promise<void> {
  if (!value) throw new CredentialError('The secret is empty.');
  await withVaultLock(stateDir, () => saveNamedSecretHeld(stateDir, name, value, meta, options));
}
async function saveNamedSecretHeld(stateDir: string, name: string, value: string, meta: SecretInput, options: { legacy?: boolean }): Promise<void> {
  // A spelling variant of a saved secret is that secret, rotated: no twin is made.
  name = await savedNameFor(stateDir, name) ?? name;
  const { file, aad } = secretFile(stateDir, name);
  const key = await vaultKey(stateDir, true);
  // A second save of the same name is a rotation: the first date stays, and what was given before stays unless given again.
  let before: { value?: string; meta?: SecretMeta } = {};
  try { before = JSON.parse(open(key, aad, await fs.readFile(file, 'utf8'))) as typeof before; } catch { /* fail-open-ok: a new secret */ }
  // A secret saved before records existed was made when its file was.
  if (before.value !== undefined && !before.meta) { const made = await fs.stat(file).then(info => info.mtime.toISOString(), () => undefined); if (made) before.meta = { createdAt: made }; }
  const now = new Date().toISOString();
  const kept = (field: 'vendor' | 'owner' | 'env' | 'page'): Partial<SecretMeta> => { const v = meta[field]?.trim() || before.meta?.[field]; return v ? { [field]: v } : {}; };
  const url = INTERNAL_SECRET.test(name) ? undefined : await baseUrlFor(stateDir, name, meta.url, before.meta?.url);
  if (!url && !INTERNAL_SECRET.test(name) && !options.legacy) throw new CredentialError(`A saved key must say which site it is for: give its base URL (https://example.com) when saving "${name}".`);
  const saved: SecretMeta = { ...kept('vendor'), ...kept('owner'), ...kept('env'), ...kept('page'), ...(url ? { url } : {}), createdAt: before.meta?.createdAt ?? now, ...(before.value !== undefined && before.value !== value ? { rotatedAt: now } : before.meta?.rotatedAt ? { rotatedAt: before.meta.rotatedAt } : {}) };
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeSealed(file, seal(key, aad, JSON.stringify({ name, value, meta: saved })));
}
/** Names with their records, never the values. */
export async function namedSecretInfo(stateDir: string): Promise<{ name: string; meta?: SecretMeta }[]> {
  const dir = path.join(vaultDir(stateDir), 'secrets');
  let files: string[];
  try { files = await fs.readdir(dir); } catch { return []; }
  const key = await vaultKey(stateDir, false);
  const out: { name: string; meta?: SecretMeta }[] = [];
  for (const file of files.filter(isRecordFile)) {
    try { const { name, meta } = JSON.parse(open(key, `secret:${file.replace(/\.json$/, '')}`, await fs.readFile(path.join(dir, file), 'utf8'))) as { name: string; meta?: SecretMeta }; out.push({ name, ...(meta ? { meta } : {}) }); }
    catch (error) { /* an unreadable file is skipped, never shown */ swallowed('agent/computer/credential-vault', error); }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
export async function readNamedSecret(stateDir: string, name: string): Promise<string> {
  const read = async (wanted: string): Promise<string> => {
    const { file, aad } = secretFile(stateDir, wanted);
    const key = await vaultKey(stateDir, false);
    return (JSON.parse(open(key, aad, await fs.readFile(file, 'utf8'))) as { value: string }).value;
  };
  try { return await read(name); } catch { /* fail-open-ok: not under that spelling: try the saved one */ }
  const saved = await savedNameFor(stateDir, name);
  if (saved) { try { return await read(saved); } catch { /* fail-open-ok: fall through to the plain error */ } }
  const near = await nearNames(stateDir, name);
  throw new CredentialError(`No secret named "${name}" is saved.${near.length ? ` Saved for that vendor: ${near.join(', ')}.` : ''}`);
}
export async function namedSecretNames(stateDir: string): Promise<string[]> {
  const dir = path.join(vaultDir(stateDir), 'secrets');
  let files: string[];
  try { files = await fs.readdir(dir); } catch { return []; }
  const key = await vaultKey(stateDir, false);
  const names: string[] = [];
  for (const file of files.filter(isRecordFile)) {
    try { names.push((JSON.parse(open(key, `secret:${file.replace(/\.json$/, '')}`, await fs.readFile(path.join(dir, file), 'utf8'))) as { name: string }).name); }
    catch (error) { /* an unreadable file is skipped, never shown */ swallowed('agent/computer/credential-vault', error); }
  }
  return names.sort();
}

/** Removes the secret `name` means, read the way readNamedSecret reads it: the exact name, else the one saved secret with the same
 * canonical form ("acme/api-key" for a saved "acme/key"). Two or more candidates is no answer, and nothing is removed. */
export async function deleteNamedSecret(stateDir: string, name: string): Promise<boolean> {
  secretFile(stateDir, name);
  return withVaultLock(stateDir, async () => {
    const saved = await savedNameFor(stateDir, name);
    if (!saved) return false;
    try { await fs.unlink(secretFile(stateDir, saved).file); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw new CredentialError('The secret could not be removed.'); }
  });
}

/** Other sealed records that live in the vault (autofill profiles): one encrypted file each, under the same key. */
const RECORD_FOLDER = /^[a-z][a-z-]{1,30}$/;
export async function writeVaultRecord(stateDir: string, folder: string, id: string, value: object): Promise<void> {
  if (!RECORD_FOLDER.test(folder) || !/^[0-9a-f-]{36}$/i.test(id)) throw new CredentialError('Invalid vault record.');
  const key = await vaultKey(stateDir, true);
  const dir = path.join(vaultDir(stateDir), folder);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await withVaultLock(stateDir, () => writeSealed(path.join(dir, `${id}.json`), seal(key, `${folder}:${id}`, JSON.stringify(value))));
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
    catch (error) { /* an unreadable record is skipped, never shown */ swallowed('agent/computer/credential-vault', error); }
  }
  return out;
}
export async function removeVaultRecord(stateDir: string, folder: string, id: string): Promise<boolean> {
  if (!RECORD_FOLDER.test(folder) || !/^[0-9a-f-]{36}$/i.test(id)) throw new CredentialError('Invalid vault record.');
  try { await fs.unlink(path.join(vaultDir(stateDir), folder, `${id}.json`)); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw new CredentialError('The record could not be removed.'); }
}

/** Gives every secret saved before records existed a vendor (the first part of its name, "netlify/client-id" is netlify) and, where it can be told, its site's base URL. The value is untouched and never leaves this file. */
export async function backfillSecretMeta(stateDir: string, owner?: string): Promise<string[]> {
  return withVaultLock(stateDir, () => backfillSecretMetaHeld(stateDir, owner));
}
async function backfillSecretMetaHeld(stateDir: string, owner?: string): Promise<string[]> {
  const done: string[] = [];
  for (const { name, meta } of await namedSecretInfo(stateDir)) {
    const vendor = name.includes('/') ? name.split('/')[0] : undefined;
    const url = INTERNAL_SECRET.test(name) || meta?.url ? undefined : await baseUrlFor(stateDir, name, undefined, undefined);
    if ((meta?.vendor || !vendor) && (meta?.owner || !owner) && !url) continue;
    await saveNamedSecretHeld(stateDir, name, await readNamedSecret(stateDir, name), { ...(vendor && !meta?.vendor ? { vendor } : {}), ...(owner && !meta?.owner ? { owner } : {}), ...(url ? { url } : {}) }, { legacy: true });
    done.push(name);
  }
  return done;
}

/** What is untidy in the vault, by name only. Nothing here changes anything. */
interface VaultAudit { /** Saved logins that could not be opened, by id: skipped by every lookup. */ unreadableLogins: string[]; twins: string[][]; oddNames: string[]; noOwner: string[]; noUrl: string[]; incompleteLogins: { site: string; label: string; method: string }[]; rejectedLogins: { site: string; label: string }[] }
export async function auditVault(stateDir: string): Promise<VaultAudit> {
  const info = await namedSecretInfo(stateDir);
  const groups = new Map<string, string[]>();
  for (const { name } of info) groups.set(canonicalSecretName(name), [...(groups.get(canonicalSecretName(name)) ?? []), name]);
  const odd = /\d{4}-\d{2}-\d{2}|-m\d+$|\btry-|-\d$/;
  const items = await readItems(stateDir);
  return {
    unreadableLogins: unreadableLoginIds(stateDir),
    twins: [...groups.values()].filter(names => names.length > 1),
    oddNames: info.map(({ name }) => name).filter(name => !name.includes('/') || odd.test(name)),
    noOwner: info.filter(({ meta }) => !meta?.owner).map(({ name }) => name),
    noUrl: info.filter(({ name, meta }) => !meta?.url && !INTERNAL_SECRET.test(name)).map(({ name }) => name),
    incompleteLogins: items.map(({ id, item }) => loginRecord(id, item)).filter(record => !record.complete).map(record => ({ site: new URL(record.site).hostname, label: record.account, method: record.method })),
    rejectedLogins: items.filter(({ item }) => item.rejected).map(({ item }) => ({ site: new URL(item.origin).hostname, label: loginLabel(itemFields(item)) })),
  };
}

/** Brings another computer's vault into this one: what is missing is added, a secret both have is the newer one, and nothing is ever removed.
 * Logins and profiles are added when missing and never replaced. Safe to run in both directions, in any order, any number of times. */
export async function mergeVault(stateDir: string, snapshot: VaultSnapshot): Promise<{ added: number; updated: number; same: number }> {
  if (snapshot?.v !== 1 || !Array.isArray(snapshot.items) || !Array.isArray(snapshot.secrets) || !Array.isArray(snapshot.records)) throw new CredentialError('That is not a ClikCode vault snapshot.');
  return withVaultLock(stateDir, () => mergeVaultHeld(stateDir, snapshot));
}
async function mergeVaultHeld(stateDir: string, snapshot: VaultSnapshot): Promise<{ added: number; updated: number; same: number }> {
  const mine = new Map((await namedSecretInfo(stateDir)).map(entry => [canonicalSecretName(entry.name), entry]));
  const stamp = (meta?: SecretMeta): string => meta?.rotatedAt ?? meta?.createdAt ?? '';
  let updated = 0, same = 0;
  const forLogins: VaultSnapshot = { v: 1, items: snapshot.items, secrets: [], records: snapshot.records };
  const logins = await restoreVaultHeld(stateDir, forLogins, {});
  let added = logins.added;
  same += logins.skipped;
  for (const secret of snapshot.secrets) {
    const have = mine.get(canonicalSecretName(secret.name));
    if (!have) { await saveNamedSecretHeld(stateDir, secret.name, secret.value, secret.meta ?? {}, { legacy: true }); await stampMeta(stateDir, secret.name, secret.meta); added++; continue; }
    if (stamp(secret.meta) > stamp(have.meta) && await readNamedSecret(stateDir, have.name) !== secret.value) { await saveNamedSecretHeld(stateDir, have.name, secret.value, secret.meta ?? {}, { legacy: true }); await stampMeta(stateDir, have.name, secret.meta); updated++; continue; }
    // The same key with a site, owner or vendor the other computer was missing: the record is filled in, the key is untouched.
    const fill = (['url', 'owner', 'vendor'] as const).filter(field => secret.meta?.[field] && !have.meta?.[field]);
    if (fill.length) { await saveNamedSecretHeld(stateDir, have.name, await readNamedSecret(stateDir, have.name), Object.fromEntries(fill.map(field => [field, secret.meta![field]])), { legacy: true }); updated++; continue; }
    same++;
  }
  return { added, updated, same };
}
/** A merged-in secret keeps the dates it had where it was made. */
async function stampMeta(stateDir: string, name: string, meta: SecretMeta | undefined): Promise<void> {
  if (!meta?.createdAt) return;
  const { file, aad } = secretFile(stateDir, name);
  const key = await vaultKey(stateDir, false);
  const record = JSON.parse(open(key, aad, await fs.readFile(file, 'utf8'))) as { meta?: SecretMeta };
  record.meta = { ...record.meta, ...meta };
  await writeSealed(file, seal(key, aad, JSON.stringify(record)));
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
  const key = await vaultKey(stateDir, false).catch(quiet('agent/computer/credential-vault'));
  const secrets: VaultSnapshot['secrets'] = [];
  const dir = path.join(vaultDir(stateDir), 'secrets');
  for (const file of key ? (await fs.readdir(dir).catch(() => [] as string[])).filter(isRecordFile) : []) {
    try { secrets.push(JSON.parse(open(key!, `secret:${file.replace(/\.json$/, '')}`, await fs.readFile(path.join(dir, file), 'utf8'))) as VaultSnapshot['secrets'][number]); }
    catch (error) { /* an unreadable file is left out of the backup, as it is out of every list */ swallowed('agent/computer/credential-vault', error); }
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
  return withVaultLock(stateDir, () => restoreVaultHeld(stateDir, snapshot, options));
}
async function restoreVaultHeld(stateDir: string, snapshot: VaultSnapshot, options: { overwrite?: boolean }): Promise<{ added: number; skipped: number }> {
  const key = await vaultKey(stateDir, true);
  let added = 0; let skipped = 0;
  const put = async (file: string, aad: string, value: unknown): Promise<void> => {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    try { await writeSealed(file, seal(key, aad, JSON.stringify(value)), { exclusive: !options.overwrite }); added++; }
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

/** Records the base URL a saved key is for. */
export async function setSecretUrl(stateDir: string, name: string, url: string): Promise<void> {
  const origin = webOrigin(url);
  if (!origin) throw new CredentialError('Give the site\'s base URL, such as https://example.com.');
  await withVaultLock(stateDir, async () => {
    const saved = await savedNameFor(stateDir, name);
    if (!saved) throw new CredentialError(`No secret named "${name}" is saved.`);
    await saveNamedSecretHeld(stateDir, saved, await readNamedSecret(stateDir, saved), { url: origin }, { legacy: true });
  });
}
