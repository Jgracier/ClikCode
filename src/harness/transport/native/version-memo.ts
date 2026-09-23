/**
 * What `<binary> --version` said, remembered across runs.
 *
 * Inspecting the catalog means spawning every installed harness: measured on
 * this machine, 1,359 ms for 24 of them. The in-memory cache made that once
 * per process, so every new ClikCode paid it again on its first `doctor`.
 *
 * The memo is not keyed on time. A version string is a fact about a FILE, so
 * it is keyed on the file: where the binary resolved, and that file's mtime
 * and size. If those are unchanged the version cannot have changed, and the
 * answer stays good indefinitely. If any of them moved -- an upgrade, a
 * different PATH entry winning, a reinstall -- the memo simply does not match
 * and the harness is inspected again.
 *
 * That is strictly better than a TTL, which is wrong in both directions: it
 * re-spawns everything on a machine where nothing changed, and serves a stale
 * version for the whole window on one where something did.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from '../../../session/store/files.js';
import { stateDirectory } from '../../../session/store/paths.js';
import { readFile } from 'node:fs/promises';
import { resolveBinaryPath } from './binary.js';

/** One harness's last inspection, tied to the file it described. */
export interface MemoizedVersion {
  path: string;
  mtimeMs: number;
  size: number;
  version?: string;
  error?: string;
}

interface VersionMemoFile { v: 1; harnesses: Record<string, MemoizedVersion> }

let memo: { path: string; data: VersionMemoFile; dirty: boolean } | undefined;

function memoPath(): string | undefined {
  // Tests that never relocated ClikCode's state must not touch the real one.
  if (process.env.VITEST && !process.env.CLIKCODE_HOME?.trim() && !process.env.CLIKDEPLOY_AI_HOME?.trim()) return undefined;
  const directory = stateDirectory();
  return directory ? join(directory, 'harness-versions.json') : undefined;
}

async function load(): Promise<VersionMemoFile> {
  const path = memoPath();
  if (memo && memo.path === (path ?? '')) return memo.data;
  let data: VersionMemoFile = { v: 1, harnesses: {} };
  if (path) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as VersionMemoFile;
      if (parsed?.v === 1 && parsed.harnesses && typeof parsed.harnesses === 'object') data = parsed;
    } catch { /* fail-open-ok: a missing or damaged memo costs one round of spawns. */ }
  }
  memo = { path: path ?? '', data, dirty: false };
  return data;
}

/** The identity of the file a binary currently resolves to, or undefined when
 * it is not there. */
export async function binaryFingerprint(path: string | undefined): Promise<{ path: string; mtimeMs: number; size: number } | undefined> {
  if (!path) return undefined;
  try {
    const info = await stat(path);
    return { path, mtimeMs: info.mtimeMs, size: info.size };
  } catch { return undefined; }
}

/** The installed harness binary as one comparable string, or undefined when
 * it is not installed. What every per-harness cache is keyed on, so that an
 * update to the vendor CLI invalidates everything learned from the old one at
 * once -- and nothing learned from an unchanged one is thrown away on a clock.
 * A PATH walk and one stat: cheap enough to check on every lookup, which is
 * what makes a time limit unnecessary for anything derived from the binary. */
export async function harnessBinaryIdentity(binary: string): Promise<string | undefined> {
  const fingerprint = await binaryFingerprint(await resolveBinaryPath(binary));
  return fingerprint ? `${fingerprint.path}:${fingerprint.mtimeMs}:${fingerprint.size}` : undefined;
}

/** The remembered inspection for this harness, if it still describes the file
 * on disk. */
export async function rememberedVersion(
  command: string, fingerprint: { path: string; mtimeMs: number; size: number } | undefined,
): Promise<MemoizedVersion | undefined> {
  if (!fingerprint) return undefined;
  const entry = (await load()).harnesses[command];
  if (!entry) return undefined;
  const same = entry.path === fingerprint.path
    && entry.mtimeMs === fingerprint.mtimeMs
    && entry.size === fingerprint.size;
  return same ? entry : undefined;
}

export async function rememberVersion(
  command: string, fingerprint: { path: string; mtimeMs: number; size: number },
  result: { version?: string; error?: string },
): Promise<void> {
  const data = await load();
  data.harnesses[command] = { ...fingerprint, ...(result.version ? { version: result.version } : {}), ...(result.error ? { error: result.error } : {}) };
  memo!.dirty = true;
}

export async function saveVersionMemo(): Promise<void> {
  const path = memoPath();
  if (!path || !memo?.dirty || memo.path !== path) return;
  memo.dirty = false;
  await atomicWriteFile(path, JSON.stringify(memo.data)).catch(() => undefined);
}

/** Forget everything, e.g. right after installing a harness. */
export function resetVersionMemo(): void { memo = undefined; }
