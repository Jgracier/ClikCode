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

export async function setComputerEnabled(stateDir: string, enabled: boolean): Promise<void> {
  const file = computerSettingsPath(stateDir);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify({ enabled })}\n`, { mode: 0o600 });
  await fs.rename(temp, file);
}

export const COMPUTER_OFF = 'Computer use is off. Run `clikcode computer on` to enable it.';
