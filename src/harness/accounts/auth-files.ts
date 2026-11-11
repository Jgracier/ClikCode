/** Sign-in state for vendors that publish no status or logout command.
 *
 * Gemini, Droid, Qwen, Continue, Vibe and others sign in only from inside
 * their own session and never say from the command line whether they are
 * signed in. Each catalog entry names where its vendor keeps the credential
 * (`authFiles`) and which environment variables sign it in by themselves
 * (`authEnv`); this reads those, so ClikCode knows before a turn fails. */

import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import type { AiLocalHarnessDefinition } from '../definition.js';
import { captureNativeHarnessOutput } from '../transport/native/command.js';

type AuthFile = NonNullable<AiLocalHarnessDefinition['authFiles']>[number];
type Environment = Readonly<Record<string, string | undefined>>;

/** `~` and `${VAR:-default}` against the profile's environment over the
 * process's own, the same environment the vendor itself will run under. */
export function expandAuthPath(path: string, environment: Environment, home = homedir()): string {
  const expanded = path.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_, name: string, fallback: string | undefined) => {
    const value = environment[name]?.trim();
    return value || (fallback ?? '');
  });
  const profileHome = environment.HOME?.trim() || home;
  return expanded.startsWith('~') ? `${profileHome}${expanded.slice(1)}` : expanded;
}

/** The files an entry names. A `*` path segment matches every entry of that
 * directory: MiniMax Code keeps its record under a region and an OAuth client
 * id (`~/.minimax/auth/prod/<region>/<client>/auth.json`). A path with no `*`
 * is itself, whether or not it exists. */
export async function expandAuthPaths(path: string, environment: Environment, home = homedir()): Promise<string[]> {
  const expanded = expandAuthPath(path, environment, home);
  if (!expanded.includes('*')) return [expanded];
  const trailing = expanded.endsWith('/') ? '/' : '';
  const segments = expanded.replace(/\/$/, '').split('/');
  let found = [segments[0] ?? ''];
  for (const segment of segments.slice(1)) {
    if (segment !== '*') { found = found.map((base) => `${base}/${segment}`); continue; }
    found = (await Promise.all(found.map(async (base) => (await readdir(base || '/').catch(() => [] as string[])).sort().map((name) => `${base}/${name}`)))).flat();
  }
  return found.map((item) => `${item}${trailing}`);
}

async function present(entry: AuthFile, environment: Environment): Promise<boolean> {
  for (const path of await expandAuthPaths(entry.path, environment)) if (await presentAt(path, entry)) return true;
  return false;
}

/** The values of an entry's `jsonFields` in `data`, in order. */
function jsonFieldValues(data: unknown, fields: readonly string[]): unknown[] {
  return fields.map((field) => field.split('.').reduce<unknown>((value, key) =>
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, data));
}

async function presentAt(path: string, entry: AuthFile): Promise<boolean> {
  try {
    if (path.endsWith('/')) return (await readdir(path)).length > 0;
    if (entry.jsonFields) {
      const data: unknown = JSON.parse(await readFile(path, 'utf8'));
      return jsonFieldValues(data, entry.jsonFields).every((value) => typeof value === 'string' && value.trim().length > 0);
    }
    if (entry.contains === undefined) return (await stat(path)).size > 0;
    return (await readFile(path, 'utf8')).includes(entry.contains);
  } catch {
    return false;
  }
}

function parsesAsJson(text: string): boolean {
  try { JSON.parse(text); return true; } catch { return false; }
}

/** Only during an explicitly requested sign-in: let the vendor start even
 * when an old JSON credential is corrupt (does not parse). Preserve it for
 * recovery instead of deleting it or guessing which trailing bytes were
 * intended. A file that parses but holds no credential is the vendor's own
 * (Claude's keeps MCP servers' OAuth beside its own) and is left alone. */
export async function prepareAuthFilesForLogin(
  harness: Pick<AiLocalHarnessDefinition, 'authFiles'>,
  profileEnvironment: Readonly<Record<string, string>>,
  processEnvironment: Environment = process.env,
): Promise<void> {
  const environment = { ...processEnvironment, ...profileEnvironment };
  for (const entry of harness.authFiles ?? []) {
    if (!entry.jsonFields) continue;
    for (const path of await expandAuthPaths(entry.path, environment)) {
      let text: string;
      try { text = await readFile(path, 'utf8'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (parsesAsJson(text)) continue;
      await rename(path, `${path}.invalid-${randomUUID()}.bak`);
    }
  }
}

/** What a credential file holds, by content: an entry's `jsonFields` values
 * where it names them (Claude's file is rewritten for every MCP server's
 * OAuth refresh too), else the file's bytes, or a directory's files'. Never
 * size or time: a file rewritten with the same credential is not a new one. */
async function credentialDigest(path: string, entry: AuthFile): Promise<string> {
  const hash = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
  if (path.endsWith('/')) {
    const names = (await readdir(path)).sort();
    return hash((await Promise.all(names.map(async (name) => `${name}:${hash(await readFile(`${path}${name}`).catch(() => ''))}`))).join('\n'));
  }
  const text = await readFile(path);
  if (!entry.jsonFields) return hash(text);
  try { return hash(JSON.stringify(jsonFieldValues(JSON.parse(text.toString('utf8')), entry.jsonFields))); } catch { return 'invalid'; }
}

/** What the credentials on disk are now -- which exist, whether each holds
 * one, and what it holds -- to tell a sign-in that wrote a credential from
 * a file that was only rewritten. */
export async function authFilesStamp(
  harness: Pick<AiLocalHarnessDefinition, 'authFiles'>,
  profileEnvironment: Readonly<Record<string, string>>,
  processEnvironment: Environment = process.env,
): Promise<string> {
  const environment = { ...processEnvironment, ...profileEnvironment };
  const parts = await Promise.all((harness.authFiles ?? []).map(async (entry) => {
    const paths = await expandAuthPaths(entry.path, environment);
    if (!paths.length) return `${entry.path}:-`;
    return (await Promise.all(paths.map(async (path) => {
      try {
        return `${path}:${await presentAt(path, entry)}:${await credentialDigest(path, entry)}`;
      } catch { return `${path}:-`; }
    }))).join('|');
  }));
  return parts.join('|');
}

/** Signed in by a credential on disk (not an API-key variable). */
export async function authFilePresent(
  harness: Pick<AiLocalHarnessDefinition, 'authFiles'>,
  profileEnvironment: Readonly<Record<string, string>>,
  processEnvironment: Environment = process.env,
): Promise<boolean> {
  const environment = { ...processEnvironment, ...profileEnvironment };
  for (const entry of harness.authFiles ?? []) if (await present(entry, environment)) return true;
  return false;
}

/** Whether ClikCode can tell this vendor's sign-in state without asking it. */
export function hasAuthEvidence(harness: Pick<AiLocalHarnessDefinition, 'authFiles' | 'authEnv'>): boolean {
  return Boolean(harness.authFiles?.length || harness.authEnv?.length);
}

/** Signed in: an API-key variable is set, or a credential is on disk. */
export async function authEvidencePresent(
  harness: Pick<AiLocalHarnessDefinition, 'authFiles' | 'authEnv'>,
  profileEnvironment: Readonly<Record<string, string>>,
  processEnvironment: Environment = process.env,
): Promise<boolean> {
  const environment = { ...processEnvironment, ...profileEnvironment };
  if (harness.authEnv?.some((name) => environment[name]?.trim())) return true;
  for (const entry of harness.authFiles ?? []) {
    if (await present(entry, environment)) return true;
  }
  return false;
}

/** What logout may remove: whole files holding nothing but the credential,
 * and `removeLine` lines. A shared config is never deleted for the key
 * inside it. */
export function removableAuthFiles(harness: Pick<AiLocalHarnessDefinition, 'authFiles'>): AuthFile[] {
  return (harness.authFiles ?? []).filter((entry) => entry.contains === undefined || entry.removeLine);
}

/** Sign out a vendor with no logout command by removing its credential
 * files. Returns the paths that existed and were removed. */
export async function removeAuthFiles(
  harness: Pick<AiLocalHarnessDefinition, 'authFiles'>,
  profileEnvironment: Readonly<Record<string, string>>,
  processEnvironment: Environment = process.env,
): Promise<string[]> {
  const environment = { ...processEnvironment, ...profileEnvironment };
  const removed: string[] = [];
  for (const entry of removableAuthFiles(harness)) {
    for (const path of await expandAuthPaths(entry.path, environment)) {
      if (!await presentAt(path, entry)) continue;
      if (entry.removeLine && entry.contains !== undefined) {
        const text = await readFile(path, 'utf8');
        await writeFile(path, text.split('\n').filter((line) => !line.includes(entry.contains!)).join('\n'), 'utf8');
      } else {
        await rm(path, { recursive: path.endsWith('/'), force: true });
      }
      removed.push(path);
    }
  }
  return removed;
}

/** Whether ClikCode can sign this vendor out: its own logout command, or
 * credential files it owns outright. */
export function harnessCanLogout(harness: AiLocalHarnessDefinition): boolean {
  return Boolean(harness.logoutArgv) || removableAuthFiles(harness).length > 0;
}

/** Sign the vendor out: its logout command where it has one, else its
 * credential files. Ends when the vendor does; a caller that must bound it passes `timeoutMs`. */
export async function logoutNativeHarness(
  harness: AiLocalHarnessDefinition, profileEnvironment: Readonly<Record<string, string>>, timeoutMs?: number,
): Promise<void> {
  if (harness.logoutArgv) {
    await captureNativeHarnessOutput(harness, harness.logoutArgv, profileEnvironment, timeoutMs);
    return;
  }
  if (!removableAuthFiles(harness).length) throw new Error(`${harness.displayName} has no logout command and keeps no credential file ClikCode can remove`);
  await removeAuthFiles(harness, profileEnvironment);
}
