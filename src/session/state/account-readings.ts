/** What the vendors last said about each account's usage, kept beside the index rather than in it.
 *
 * A usage reading is a cache: every window re-asks within a minute, and losing the last one costs
 * one more question. Stored in index.json it was the most frequent reason the index was rewritten
 * -- twice per probe, from every window and editor tab -- and each rewrite fsynced the 380 KB index
 * and its directory under the lock all of them share: 400-800 ms a time, measured 2026-10-18
 * (state.write.slow), while every other window waited. Here it is written without fsync (a crash
 * loses at most the last reading), and the index changes only when something real did.
 *
 * In memory nothing changes: `account.usage` and `account.usageCheckedAt` are where they were. An
 * older build still writes them into index.json; the newer of the two copies wins. */

import { quiet } from '../../runtime/lifecycle-log.js';
import { join } from 'node:path';
import type { AiHarnessAccount } from '../../harness/definition.js';
import { cachedFile } from '../store/cached-file.js';
import { sameData } from '../store/data.js';
import { atomicWriteFile } from '../store/files.js';
import { stateDirectory } from '../store/paths.js';

type Reading = Pick<AiHarnessAccount, 'usage' | 'usageCheckedAt'>;
export type Readings = Readonly<Record<string, Reading>>;

function readingsPath(): string {
  return join(stateDirectory(), 'account-usage.json');
}

const readingsFile = cachedFile<Readings>(readingsPath, (raw) => {
  const parsed = JSON.parse(raw) as { accounts?: unknown };
  return parsed?.accounts && typeof parsed.accounts === 'object' ? parsed.accounts as Readings : {};
});

const EMPTY: Readings = {};

export async function loadReadings(): Promise<Readings> {
  // fail-open-ok: a damaged readings file costs one usage probe per account, nothing else.
  return (await readingsFile.load().catch(quiet('session/state/account-readings'))) ?? EMPTY;
}

const time = (at: string | undefined): number => {
  const parsed = Date.parse(at ?? '');
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
};

/** Accounts as read, with their readings: each field from whichever copy is newer. */
export function hydrateAccountReadings(accounts: readonly AiHarnessAccount[], readings: Readings): AiHarnessAccount[] {
  if (readings === EMPTY) return accounts as AiHarnessAccount[];
  return accounts.map((account) => {
    const stored = readings[account.id];
    if (!stored) return account;
    const usage = time(stored.usage?.at) > time(account.usage?.at) ? stored.usage : account.usage;
    const checked = time(stored.usageCheckedAt) > time(account.usageCheckedAt) ? stored.usageCheckedAt : account.usageCheckedAt;
    return { ...account, ...(usage ? { usage } : {}), ...(checked ? { usageCheckedAt: checked } : {}) };
  });
}

/** Accounts as the index stores them: their readings written to their own file first (under the
 * state lock, like the index), and left off the index. */
export async function storeAccountReadings(accounts: readonly AiHarnessAccount[]): Promise<AiHarnessAccount[]> {
  const readings: Record<string, Reading> = {};
  const stored = accounts.map((account) => {
    const { usage, usageCheckedAt, ...rest } = account;
    if (usage || usageCheckedAt) readings[account.id] = { ...(usage ? { usage } : {}), ...(usageCheckedAt ? { usageCheckedAt } : {}) };
    return rest as AiHarnessAccount;
  });
  if (!sameData(await loadReadings(), readings)) {
    const raw = JSON.stringify({ accounts: readings });
    await atomicWriteFile(readingsPath(), raw, { durable: false });
    await readingsFile.remember(raw, readings);
  }
  return stored;
}
