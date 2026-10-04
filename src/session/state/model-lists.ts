/** Accounts' model lists, stored once each.
 *
 * Every account of a harness carries the same discovered list -- thirteen
 * Cursor accounts held thirteen copies of one 2KB list, a fifth of the index.
 * On disk an account names its list by content hash (`modelsRef`) and the
 * lists live in `account-models.json`; in memory `account.models` is the full
 * list as always, so nothing outside this file knows.
 *
 * A non-empty `models` array on disk wins over a reference: an older build
 * still running in another terminal writes the full list, and that is the
 * newer fact. The next write from this build stores it by reference again. */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { AiHarnessAccount } from '../../harness/definition.js';
import { cachedFile } from '../store/cached-file.js';
import { sameData } from '../store/data.js';
import { atomicWriteFile } from '../store/files.js';
import { stateDirectory } from '../store/paths.js';

type Lists = Record<string, string[]>;
type StoredAccount = AiHarnessAccount & { modelsRef?: string };

function listsPath(): string {
  return join(stateDirectory(), 'account-models.json');
}

const listsFile = cachedFile<Lists>(listsPath, (raw) => {
  const parsed = JSON.parse(raw) as { lists?: unknown };
  const lists: Lists = {};
  if (parsed?.lists && typeof parsed.lists === 'object') {
    for (const [key, value] of Object.entries(parsed.lists as Record<string, unknown>)) {
      if (Array.isArray(value)) lists[key] = value.filter((item): item is string => typeof item === 'string');
    }
  }
  return lists;
});

async function loadLists(): Promise<Lists> {
  // fail-open-ok: a damaged list file costs one model rediscovery, never an account.
  return (await listsFile.load().catch(() => undefined)) ?? {};
}

function listKey(models: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(models)).digest('hex').slice(0, 16);
}

/** Accounts as read from the index, with their lists filled in. */
export async function hydrateAccountModels(accounts: readonly AiHarnessAccount[]): Promise<AiHarnessAccount[]> {
  if (!accounts.some((account) => (account as StoredAccount).modelsRef)) return accounts as AiHarnessAccount[];
  const lists = await loadLists();
  return accounts.map((stored) => {
    const { modelsRef, ...account } = stored as StoredAccount;
    if (!modelsRef) return stored;
    if (Array.isArray(account.models) && account.models.length) return account;
    return { ...account, models: lists[modelsRef] ? [...lists[modelsRef]] : [] };
  });
}

/** Accounts as stored on the index, writing the lists they refer to first.
 * Runs under the state lock. `replacing` is the index file being replaced:
 * a reader may still be holding it, so its lists stay one more write. */
export async function storeAccountModels(accounts: readonly AiHarnessAccount[], replacing: readonly AiHarnessAccount[] = []): Promise<AiHarnessAccount[]> {
  const disk = await loadLists();
  const lists: Lists = {};
  for (const account of replacing) {
    const key = (account as StoredAccount).modelsRef;
    if (key && disk[key]) lists[key] = disk[key];
  }
  const stored = accounts.map((account) => {
    const { modelsRef: _stale, ...rest } = account as StoredAccount;
    if (!Array.isArray(rest.models) || !rest.models.length) return rest;
    const key = listKey(rest.models);
    lists[key] = rest.models;
    return { ...rest, models: [], modelsRef: key } as StoredAccount;
  });
  // A list neither index refers to goes with this write.
  if (!sameData(disk, lists)) {
    const raw = JSON.stringify({ lists });
    await atomicWriteFile(listsPath(), raw);
    await listsFile.remember(raw, lists);
  }
  return stored;
}

export function resetAccountModelsCache(): void {
  listsFile.reset();
}
