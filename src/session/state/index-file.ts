/** The state index file itself: parsing it, its version gate, and the single
 * cached copy every read shares. */

import { readFile } from 'node:fs/promises';
import type { AiHarnessAccount } from '../../harness/definition.js';
import type { HarnessDefaultSettings, HarnessState } from '../model.js';
import { cloneData } from '../store/data.js';
import { atomicWriteFile } from '../store/files.js';
import { cachedFile } from '../store/cached-file.js';
import { resetSessionStoreCache } from '../store/records.js';
import { loadInvocationLog, resetInvocationLogCache, storeInvocationLog, type Invocation, type InvocationLog, type InvocationRollup } from './invocations.js';
import { hydrateAccountModels, resetAccountModelsCache, storeAccountModels } from './model-lists.js';
import type { SessionMeta } from './merge.js';
import { HARNESS_STATE_VERSION, harnessIndexPath } from './paths.js';

export interface StateIndex {
  version: number;
  installationId: string;
  devicePublicKey?: Record<string, unknown>;
  accounts: AiHarnessAccount[];
  sessions: SessionMeta[];
  /** Every invocation on record. Stored in invocations.jsonl, not in index.json. */
  invocations: Invocation[];
  invocationRollups: Record<string, InvocationRollup>;
  /** Newest `at` ever folded into a rollup; guards a re-import from double counting. */
  rolledThrough?: string;
  globalSettings: HarnessDefaultSettings;
  providerSettings: HarnessState['providerSettings'];
}

export class HarnessStateVersionError extends Error {
  constructor(found: number) {
    super(`Local ClikCode state is version ${found}, written by a newer ClikCode than this one (supports up to ${HARNESS_STATE_VERSION}). `
      + 'It can be read but not changed from here. Update ClikCode to continue.');
    this.name = 'HarnessStateVersionError';
  }
}

const HARNESS_STATE_STATS = { indexWrites: 0 };

function parseIndex(raw: string): StateIndex {
  const parsed = JSON.parse(raw) as Partial<StateIndex>;
  if (typeof parsed?.version !== 'number' || !Array.isArray(parsed.accounts) || !Array.isArray(parsed.sessions)) {
    throw new Error('unsupported local AI harness state');
  }
  return {
    ...parsed,
    // Only an index from before the log moved out (or one an older build
    // still running wrote) holds invocations; loadIndex folds them in.
    invocations: Array.isArray(parsed.invocations) ? parsed.invocations : [],
    invocationRollups: parsed.invocationRollups && typeof parsed.invocationRollups === 'object' ? parsed.invocationRollups : {},
  } as StateIndex;
}

/** The index file as stored: parsed once per version of it. */
const indexFile = cachedFile(harnessIndexPath, parseIndex);

/** The assembled index -- index.json, the invocation log, the model lists --
 * kept while none of its parts changed. Treated as immutable. */
let assembled: { file: StateIndex; log: InvocationLog; index: StateIndex } | undefined;

async function assemble(file: StateIndex): Promise<StateIndex> {
  const log = await loadInvocationLog();
  if (assembled && assembled.file === file && assembled.log === log) return assembled.index;
  let invocations = log.invocations;
  if (file.invocations.length) {
    const logged = new Set(invocations.map((invocation) => invocation.id));
    invocations = [...invocations, ...file.invocations.filter((invocation) => !logged.has(invocation.id))];
  }
  const index = { ...file, accounts: await hydrateAccountModels(file.accounts), invocations };
  assembled = { file, log, index };
  return index;
}

/** The merge base for a write, and the source for a read.
 *
 * Only a genuinely absent file means "nothing there". Any other failure must
 * NOT fall back to the caller's copy: that would replace the registry and erase
 * every other terminal's work. A damaged primary falls back to the backup
 * written beside it; if neither can be read the operation refuses. */
export async function loadIndex(): Promise<StateIndex | undefined> {
  let file: StateIndex | undefined;
  try {
    file = await indexFile.load();
  } catch (error) {
    try {
      file = parseIndex(await readFile(`${harnessIndexPath()}.bak`, 'utf8'));
    } catch (backupError) {
      if ((backupError as NodeJS.ErrnoException).code === 'ENOENT') throw error;
      throw backupError;
    }
  }
  return file ? assemble(file) : undefined;
}

/** Whether `next` adds, removes or reorders a conversation or an account
 * relative to `previous`: the changes a damaged index would be costly to lose. */
export function indexStructureChanged(previous: StateIndex | undefined, next: StateIndex): boolean {
  if (!previous) return true;
  const ids = (list: readonly { id: string }[]): string => list.map((item) => item.id).join('\n');
  return ids(previous.sessions) !== ids(next.sessions) || ids(previous.accounts) !== ids(next.accounts);
}

/** Writes the index and the files beside it, under the caller's state lock.
 * Its parts go first (the invocation log, the model lists), index.json last:
 * a record moved out of the index is always somewhere.
 *
 * `backup` also refreshes `index.json.bak`, loadIndex's fallback for a
 * damaged primary -- written atomically like the primary, and only when
 * asked (a structural change): copying it beside every field edit doubled
 * every index write for a file that is only read after damage. */
export async function storeIndex(index: StateIndex, options: { backup: boolean }): Promise<void> {
  const path = harnessIndexPath();
  await storeInvocationLog(index.invocations);
  const { invocations: _logged, ...rest } = index;
  const replacing = await indexFile.load().catch(() => undefined);
  const file = { ...rest, accounts: await storeAccountModels(index.accounts, replacing?.accounts) };
  const raw = `${JSON.stringify(file)}\n`;
  // What is there already says the same: a rename would only wake every
  // list watching the directory, and the backup is no newer either.
  if (replacing && raw === indexFile.raw()) return;
  await atomicWriteFile(path, raw);
  HARNESS_STATE_STATS.indexWrites += 1;
  await indexFile.remember(raw, { ...cloneData(file), invocations: [] } as StateIndex);
  if (options.backup) await atomicWriteFile(`${path}.bak`, raw).catch(() => undefined);
}

export function resetHarnessStateCaches(): void {
  indexFile.reset();
  assembled = undefined;
  resetInvocationLogCache();
  resetAccountModelsCache();
  resetSessionStoreCache();
}
