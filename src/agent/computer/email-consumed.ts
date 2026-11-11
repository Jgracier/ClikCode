/** Emails already handed to a waiter, kept on disk so two agents (two processes) never take the same message. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from '../../session/store/locks.js';
import { swallowed } from '../../runtime/lifecycle-log.js';

const KEEP_MS = 24 * 3_600_000;
const file = (stateDir: string): string => path.join(stateDir, 'computer', 'email-consumed.json');

/** The record is read, changed and written under the shared file lock: a holder that died is known by its pid, not guessed from the lock's age. */
const locked = <T>(stateDir: string, work: () => Promise<T>): Promise<T> => withFileLock(`${file(stateDir)}.lock`, work);

/** Marks one message as taken. False when another waiter already took it. */
export async function claimMessage(stateDir: string, id: string): Promise<boolean> {
  return locked(stateDir, async () => {
    let record: Record<string, number> = {};
    try { record = JSON.parse(await fs.readFile(file(stateDir), 'utf8')) as Record<string, number>; } catch (error) { /* none yet */ swallowed('agent/computer/email-consumed', error); }
    const now = Date.now();
    for (const [key, at] of Object.entries(record)) if (now - at > KEEP_MS) delete record[key];
    if (record[id]) return false;
    record[id] = now;
    await fs.writeFile(file(stateDir), JSON.stringify(record), { mode: 0o600 });
    return true;
  });
}

export async function isClaimed(stateDir: string, id: string): Promise<boolean> {
  try { return Boolean((JSON.parse(await fs.readFile(file(stateDir), 'utf8')) as Record<string, number>)[id]); } catch { return false; }
}
