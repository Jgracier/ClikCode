/** Computer control is available by default; an account-local setting can turn it off. */
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

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
  const file = computerSettingsPath(stateDir);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let current: Record<string, unknown> = {};
  try { current = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>; } catch { /* none yet */ }
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify({ ...current, ...change })}\n`, { mode: 0o600 });
  await fs.rename(temp, file);
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
