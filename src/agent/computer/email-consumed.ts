/** Emails already handed to a waiter, kept on disk so two agents (two processes) never take the same message. */
import fs from 'node:fs/promises';
import path from 'node:path';

const KEEP_MS = 24 * 3_600_000;
const file = (stateDir: string): string => path.join(stateDir, 'computer', 'email-consumed.json');

async function locked<T>(stateDir: string, work: () => Promise<T>): Promise<T> {
  const lock = `${file(stateDir)}.lock`;
  await fs.mkdir(path.dirname(lock), { recursive: true, mode: 0o700 });
  for (let attempt = 0; ; attempt++) {
    try { (await fs.open(lock, 'wx')).close(); break; }
    catch {
      // A lock older than a few seconds belongs to a process that died.
      const age = await fs.stat(lock).then(info => Date.now() - info.mtimeMs, () => 0);
      if (age > 10_000) await fs.rm(lock, { force: true });
      else if (attempt > 200) throw new Error('The consumed-email record is busy.');
      else await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  try { return await work(); } finally { await fs.rm(lock, { force: true }); }
}

/** Marks one message as taken. False when another waiter already took it. */
export async function claimMessage(stateDir: string, id: string): Promise<boolean> {
  return locked(stateDir, async () => {
    let record: Record<string, number> = {};
    try { record = JSON.parse(await fs.readFile(file(stateDir), 'utf8')) as Record<string, number>; } catch { /* none yet */ }
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
