/** Computer control is available by default; an account-local setting can turn it off. */
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { objectOrEmpty, updateJsonFile } from '../../session/store/json-file.js';

export function computerSettingsPath(stateDir: string): string {
  return path.join(stateDir, 'computer', 'settings.json');
}

export async function computerEnabled(stateDir: string): Promise<boolean> {
  try { return (JSON.parse(await fs.readFile(computerSettingsPath(stateDir), 'utf8')) as { enabled?: unknown }).enabled !== false; }
  catch { return true; }
}

/** Permission decisions are synchronous; tool execution rechecks the setting. */
export function computerEnabledSync(stateDir: string): boolean {
  try { return (JSON.parse(readFileSync(computerSettingsPath(stateDir), 'utf8')) as { enabled?: unknown }).enabled !== false; }
  catch { return true; }
}

async function writeSettings(stateDir: string, change: Record<string, boolean>): Promise<void> {
  await updateJsonFile(computerSettingsPath(stateDir), objectOrEmpty, (current) => ({ ...current, ...change }));
}

export async function setComputerEnabled(stateDir: string, enabled: boolean): Promise<void> {
  await writeSettings(stateDir, { enabled });
}

/** On unless the user turned it off (`clikcode computer passwords off`): the browser tool makes up a strong, unique
 * password for each signup form it fills, keeps it in Secrets Manager with the login, and never shows it. */
export async function generatedPasswordsAllowed(stateDir: string): Promise<boolean> {
  try { return (JSON.parse(await fs.readFile(computerSettingsPath(stateDir), 'utf8')) as { generatePasswords?: unknown }).generatePasswords !== false; }
  catch { return true; }
}

export async function setGeneratedPasswords(stateDir: string, allowed: boolean): Promise<void> {
  await writeSettings(stateDir, { generatePasswords: allowed });
}

/** Off unless the user turned it on (`clikcode computer headless on`) or CLIKCODE_BROWSER_HEADLESS=1: the browser runs
 * with no window at all. A Linux computer with no display does this by itself. */
export async function headlessSetting(stateDir: string): Promise<boolean> {
  try { return (JSON.parse(await fs.readFile(computerSettingsPath(stateDir), 'utf8')) as { headless?: unknown }).headless === true; }
  catch { return false; }
}

export async function setHeadless(stateDir: string, on: boolean): Promise<void> {
  await writeSettings(stateDir, { headless: on });
}

/** Which browser a tab runs in. `local` (default): ClikCode's own Chrome only. `auto`: local first, and a tab moves to
 * Browser Use Cloud only when asked to (a page the local browser cannot get past). `browser-use`: every tab in the cloud.
 * The cloud is a billed remote browser; turning it on never copies local cookies. */
export type BrowserProvider = 'local' | 'auto' | 'browser-use';
export async function browserProvider(stateDir: string): Promise<BrowserProvider> {
  try {
    const value = (JSON.parse(await fs.readFile(computerSettingsPath(stateDir), 'utf8')) as { browserProvider?: unknown }).browserProvider;
    return value === 'browser-use' || value === 'auto' ? value : 'local';
  } catch { return 'local'; }
}
export async function setBrowserProvider(stateDir: string, provider: BrowserProvider): Promise<void> {
  await updateJsonFile(computerSettingsPath(stateDir), objectOrEmpty, current => ({ ...current, browserProvider: provider }));
}

export const COMPUTER_OFF = 'Computer use is off. Run `clikcode computer on` to enable it.';

/** Off unless the user turned it on: a private prompt the browser tool would show (a password, a code, an account
 * choice) is instead parked in the vendor queue as needs-human, and the agent is told to move on. For a long run
 * over many vendors that nobody sits through. */
export async function unattendedEnabled(stateDir: string): Promise<boolean> {
  try { return (JSON.parse(await fs.readFile(computerSettingsPath(stateDir), 'utf8')) as { unattended?: unknown }).unattended === true; }
  catch { return false; }
}

export async function setUnattended(stateDir: string, on: boolean): Promise<void> {
  await writeSettings(stateDir, { unattended: on });
}
