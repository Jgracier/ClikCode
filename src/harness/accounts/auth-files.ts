/** Sign-in state for vendors that publish no status or logout command.
 *
 * Gemini, Droid, Qwen, Continue, Vibe and others sign in only from inside
 * their own session and never say from the command line whether they are
 * signed in. Each catalog entry names where its vendor keeps the credential
 * (`authFiles`) and which environment variables sign it in by themselves
 * (`authEnv`); this reads those, so ClikCode knows before a turn fails. */

import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

async function presentAt(path: string, entry: AuthFile): Promise<boolean> {
  try {
    if (path.endsWith('/')) return (await readdir(path)).length > 0;
    if (entry.contains === undefined) return (await stat(path)).size > 0;
    return (await readFile(path, 'utf8')).includes(entry.contains);
  } catch {
    return false;
  }
}

/** What the credential files are now -- which exist, their size and
 * time, whether they hold the credential -- to tell a sign-in that just
 * wrote one from a credential that was already there (a reauthentication). */
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
        const info = await stat(path);
        return `${path}:${info.size}:${info.mtimeMs}:${await presentAt(path, entry)}`;
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
 * credential files. Bounded, so an offline vendor cannot hang the caller. */
export async function logoutNativeHarness(
  harness: AiLocalHarnessDefinition, profileEnvironment: Readonly<Record<string, string>>, timeoutMs = 20_000,
): Promise<void> {
  if (harness.logoutArgv) {
    await captureNativeHarnessOutput(harness, harness.logoutArgv, profileEnvironment, timeoutMs);
    return;
  }
  if (!removableAuthFiles(harness).length) throw new Error(`${harness.displayName} has no logout command and keeps no credential file ClikCode can remove`);
  await removeAuthFiles(harness, profileEnvironment);
}
