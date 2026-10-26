/** Two small pieces of per-vendor state a keygrab run leaves for the next command:
 *  - the parked record: the hidden tab is kept open on the last page when keygrab could not finish, and this file says where it is, what
 *    was tried and what recorder journal to carry on with, so `clikcode connectors resume <id>` reattaches and goes on;
 *  - the back-off: after a captcha shows on a vendor the runner does not try that vendor again for six hours.
 * Nothing here holds a secret: addresses without queries, control names, short trails. */
import { quiet } from '../../runtime/lifecycle-log.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { JournalData } from './recipe-recorder.js';

export const BACKOFF_HOURS = 6;
export const MAX_PARKED = 6;

export interface ParkedRecord {
  id: string; marker: string; parkedAt: string;
  /** The page the tab was left on (address without query). */ url: string;
  /** Where the run began, for the resumed run's start page and key-page paths. */ vendorUrl: string; alternates?: string[];
  trail: string[]; controls: string[]; visited: string[]; menus: string[]; why: string;
  signedIn?: boolean;
  journal?: JournalData;
}

const dir = (stateDir: string): string => path.join(stateDir, 'computer', 'parked');
const file = (stateDir: string, id: string): string => path.join(dir(stateDir), `${id.replace(/[^a-z0-9-]/gi, '_')}.json`);
export const markerFor = (id: string): string => `clikcode-keygrab:${id}`;

export async function saveParked(stateDir: string, record: ParkedRecord): Promise<void> {
  await fs.mkdir(dir(stateDir), { recursive: true, mode: 0o700 });
  await fs.writeFile(file(stateDir, record.id), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}
export async function loadParked(stateDir: string, id: string): Promise<ParkedRecord | undefined> {
  try { return JSON.parse(await fs.readFile(file(stateDir, id), 'utf8')) as ParkedRecord; } catch { return undefined; }
}
export async function clearParked(stateDir: string, id: string): Promise<void> { await fs.unlink(file(stateDir, id)).catch(quiet('agent/computer/keygrab-park')); }
export async function listParked(stateDir: string): Promise<ParkedRecord[]> {
  const names = await fs.readdir(dir(stateDir)).catch(() => [] as string[]);
  const out: ParkedRecord[] = [];
  for (const name of names) {
    try { out.push(JSON.parse(await fs.readFile(path.join(dir(stateDir), name), 'utf8')) as ParkedRecord); } catch { /* skip a damaged record */ }
  }
  return out.sort((a, b) => a.parkedAt.localeCompare(b.parkedAt));
}

const backoffFile = (stateDir: string): string => path.join(stateDir, 'computer', 'backoff.json');
async function readBackoff(stateDir: string): Promise<Record<string, string>> {
  try { return JSON.parse(await fs.readFile(backoffFile(stateDir), 'utf8')) as Record<string, string>; } catch { return {}; }
}
/** Starts (or restarts) the vendor's back-off from `now`; returns when it ends. */
export async function recordBackoff(stateDir: string, id: string, now = new Date(), hours = BACKOFF_HOURS): Promise<Date> {
  const until = new Date(now.getTime() + hours * 3_600_000);
  const all = await readBackoff(stateDir);
  for (const [key, value] of Object.entries(all)) if (new Date(value).getTime() <= now.getTime()) delete all[key];
  all[id] = until.toISOString();
  await fs.mkdir(path.dirname(backoffFile(stateDir)), { recursive: true, mode: 0o700 });
  await fs.writeFile(backoffFile(stateDir), `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  return until;
}
/** When the vendor may be tried again, or undefined when no back-off is running. */
export async function backoffUntil(stateDir: string, id: string, now = new Date()): Promise<Date | undefined> {
  const value = (await readBackoff(stateDir))[id];
  const until = value ? new Date(value) : undefined;
  return until && until.getTime() > now.getTime() ? until : undefined;
}
