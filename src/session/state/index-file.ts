/** The state index file itself: parsing it, its version gate, and the single
 * cached copy every read shares. */

import { readFile, stat } from 'node:fs/promises';
import type { AiHarnessAccount } from '../../harness/definition.js';
import type { HarnessDefaultSettings, HarnessState } from '../model.js';
import { cloneData } from '../store/data.js';
import { atomicWriteFile } from '../store/files.js';
import { stateDirectory } from '../store/paths.js';
import { resetSessionStoreCache } from '../store/records.js';
import type { Invocation, InvocationRollup } from './invocations.js';
import type { SessionMeta } from './merge.js';
import { HARNESS_STATE_VERSION, harnessIndexPath } from './paths.js';

export interface StateIndex {
  version: number;
  installationId: string;
  devicePublicKey?: Record<string, unknown>;
  accounts: AiHarnessAccount[];
  sessions: SessionMeta[];
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

/** Parsed index keyed by the exact bytes it came from. Comparing bytes rather
 * than mtime means a merge base can never be stale, and an unchanged index is
 * never re-parsed. Treated as immutable. `identity` lets an unchanged file
 * skip even the read: every write replaces it by rename, so a new inode,
 * size or ctime is guaranteed whenever its bytes change. */
let indexCache: { directory: string; raw: string; index: StateIndex; identity?: string } | undefined;

function fileIdentity(info: { ino: number; size: number; mtimeMs: number; ctimeMs: number }): string {
  return `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

function parseIndex(raw: string): StateIndex {
  const parsed = JSON.parse(raw) as Partial<StateIndex>;
  if (typeof parsed?.version !== 'number' || !Array.isArray(parsed.accounts) || !Array.isArray(parsed.sessions)) {
    throw new Error('unsupported local AI harness state');
  }
  return {
    ...parsed,
    invocations: Array.isArray(parsed.invocations) ? parsed.invocations : [],
    invocationRollups: parsed.invocationRollups && typeof parsed.invocationRollups === 'object' ? parsed.invocationRollups : {},
  } as StateIndex;
}

/** The merge base for a write, and the source for a read.
 *
 * Only a genuinely absent file means "nothing there". Any other failure must
 * NOT fall back to the caller's copy: that would replace the registry and erase
 * every other terminal's work. A damaged primary falls back to the backup
 * written beside it; if neither can be read the operation refuses. */
export async function loadIndex(): Promise<StateIndex | undefined> {
  const path = harnessIndexPath();
  let raw: string;
  let identity: string | undefined;
  try {
    const before = await stat(path);
    identity = fileIdentity(before);
    if (indexCache && indexCache.directory === stateDirectory() && indexCache.identity === identity) return indexCache.index;
    raw = await readFile(path, 'utf8');
    // Replaced between the stat and the read: do not pin these bytes to it.
    if (fileIdentity(await stat(path)) !== identity) identity = undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (indexCache && indexCache.directory === stateDirectory() && indexCache.raw === raw) {
    if (identity) indexCache.identity = identity;
    return indexCache.index;
  }
  try {
    const index = parseIndex(raw);
    indexCache = { directory: stateDirectory(), raw, index, ...(identity ? { identity } : {}) };
    return index;
  } catch (error) {
    try {
      return parseIndex(await readFile(`${path}.bak`, 'utf8'));
    } catch (backupError) {
      if ((backupError as NodeJS.ErrnoException).code === 'ENOENT') throw error;
      throw backupError;
    }
  }
}

/** Whether `next` adds, removes or reorders a conversation or an account
 * relative to `previous`: the changes a damaged index would be costly to lose. */
export function indexStructureChanged(previous: StateIndex | undefined, next: StateIndex): boolean {
  if (!previous) return true;
  const ids = (list: readonly { id: string }[]): string => list.map((item) => item.id).join('\n');
  return ids(previous.sessions) !== ids(next.sessions) || ids(previous.accounts) !== ids(next.accounts);
}

/** Writes the index. `backup` also refreshes `index.json.bak`, loadIndex's
 * fallback for a damaged primary -- written atomically like the primary, and
 * only when asked (a structural change): copying 600KB beside every field
 * edit doubled every index write for a file that is only read after damage. */
export async function storeIndex(index: StateIndex, options: { backup: boolean }): Promise<void> {
  const path = harnessIndexPath();
  const raw = `${JSON.stringify(index)}\n`;
  await atomicWriteFile(path, raw);
  HARNESS_STATE_STATS.indexWrites += 1;
  const info = await stat(path).catch(() => undefined);
  indexCache = { directory: stateDirectory(), raw, index: cloneData(index), ...(info ? { identity: fileIdentity(info) } : {}) };
  if (options.backup) await atomicWriteFile(`${path}.bak`, raw).catch(() => undefined);
}

export function resetHarnessStateCaches(): void {
  indexCache = undefined;
  resetSessionStoreCache();
}
