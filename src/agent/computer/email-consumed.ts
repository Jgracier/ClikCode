/** Emails (and texted codes) already handed to a waiter, kept on disk so two agents (two processes) never take the same message. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from '../../session/store/locks.js';
import { swallowed } from '../../runtime/lifecycle-log.js';

const KEEP_MS = 24 * 3_600_000;
/** `store`: which record -- 'email' (email-consumed.json) or 'sms' (sms-consumed.json). */
export type ConsumedStore = 'email' | 'sms';
const file = (stateDir: string, store: ConsumedStore = 'email'): string => path.join(stateDir, 'computer', `${store}-consumed.json`);

/** The record is read, changed and written under the shared file lock: a holder that died is known by its pid, not guessed from the lock's age. */
const locked = <T>(stateDir: string, store: ConsumedStore, work: () => Promise<T>): Promise<T> => withFileLock(`${file(stateDir, store)}.lock`, work);

/** Marks one message as taken. False when another waiter already took it. */
export async function claimMessage(stateDir: string, id: string, store: ConsumedStore = 'email'): Promise<boolean> {
  return locked(stateDir, store, async () => {
    let record: Record<string, number> = {};
    try { record = JSON.parse(await fs.readFile(file(stateDir, store), 'utf8')) as Record<string, number>; } catch (error) { /* none yet */ swallowed('agent/computer/email-consumed', error); }
    const now = Date.now();
    for (const [key, at] of Object.entries(record)) if (now - at > KEEP_MS) delete record[key];
    if (record[id]) return false;
    record[id] = now;
    await fs.mkdir(path.dirname(file(stateDir, store)), { recursive: true });
    await fs.writeFile(file(stateDir, store), JSON.stringify(record), { mode: 0o600 });
    return true;
  });
}

export async function isClaimed(stateDir: string, id: string, store: ConsumedStore = 'email'): Promise<boolean> {
  try { return Boolean((JSON.parse(await fs.readFile(file(stateDir, store), 'utf8')) as Record<string, number>)[id]); } catch { return false; }
}
