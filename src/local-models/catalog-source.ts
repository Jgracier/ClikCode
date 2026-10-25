/** Where ClikCode Local's model catalog comes from: ClikDeploy's signed public catalog.
 *
 * Local models are free and need no sign-in, so the catalog is public data. The fit, speed and
 * quantization decision runs here, on this machine, over it (see ./shared); nothing about the
 * machine is sent -- the refresh below is a plain GET with no identity, at most once a day.
 *
 * Read order, every source checked the same way (Ed25519 over the canonical JSON against the keys
 * embedded below, a known schema, and a version no lower than the bundled snapshot's):
 *   1. the cache in the state directory, written by the last successful refresh;
 *   2. the snapshot bundled with this build, so a fresh offline install, or ClikDeploy being down,
 *      still works.
 * A document that fails a check is refused with a diagnostic and the next source is used; an
 * unsigned file is never read. The refresh never blocks a turn or startup: it runs in the
 * background and its result is used from the next read on. */

import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DEFAULT_GATEWAY_URL } from '../constants.js';
import { atomicWriteFile } from '../session/store/files.js';
import snapshot from './catalog.snapshot.json' with { type: 'json' };
import { catalogCacheFile } from './paths.js';
import { verifySignedCatalog, type TrustedCatalogKey } from './shared/catalog-signature.js';
import type { CatalogModel, LocalCatalog } from './shared/index.js';

/** Public keys whose signature is accepted. A rotation adds the new key one release before
 * ClikDeploy signs with it (its TRUSTED_CATALOG_KEYS is the other copy), then drops the old one. */
export const TRUSTED_CATALOG_KEYS: readonly TrustedCatalogKey[] = [
  { keyId: '4a2621a6517c8923', publicKey: 'u6QGJq3feNYedfQ7re8LTp9SoZ9EMWzbZhsNeCEHD9k=' },
];

export const CATALOG_URL = `${DEFAULT_GATEWAY_URL}/api/models/local/catalog`;
export const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 5_000;

export interface CatalogCache {
  /** Epoch ms of the last successful check against ClikDeploy (a new body or a 304). */
  checkedAt: number;
  etag?: string;
  /** The signed document exactly as served. */
  document: unknown;
}

export interface LoadedCatalog {
  catalog: LocalCatalog;
  source: 'cache' | 'bundled';
  /** Why a source earlier in the read order was not used. */
  diagnostics: string[];
}

export interface CatalogSourceOptions {
  cacheFile?: string;
  keys?: readonly TrustedCatalogKey[];
  /** The bundled signed document. */
  bundled?: unknown;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bundledCatalog(options: CatalogSourceOptions): LocalCatalog {
  // A bundled snapshot that does not verify is a broken build, not a condition to route around.
  return verifySignedCatalog(options.bundled ?? snapshot, options.keys ?? TRUSTED_CATALOG_KEYS);
}

/** The catalog inside a signed document if it is acceptable against `floor` (the lowest version
 * to take), else the reason it is not. */
function accept(document: unknown, floor: number, keys: readonly TrustedCatalogKey[]): { catalog: LocalCatalog } | { refused: string } {
  let catalog: LocalCatalog;
  try { catalog = verifySignedCatalog(document, keys); } catch (error) { return { refused: message(error) }; }
  if (catalog.version < floor) return { refused: `The model catalog is version ${catalog.version}, older than the ${floor} already held.` };
  return { catalog };
}

function readCache(file: string): CatalogCache | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const { checkedAt, etag, document } = parsed as Partial<CatalogCache>;
    if (typeof checkedAt !== 'number' || document === undefined) return undefined;
    return { checkedAt, document, ...(typeof etag === 'string' ? { etag } : {}) };
  } catch { return undefined; }
}

/** The catalog to use now: the cache if it verifies, else the bundled snapshot. */
export function loadCatalog(options: CatalogSourceOptions = {}): LoadedCatalog {
  const keys = options.keys ?? TRUSTED_CATALOG_KEYS;
  const bundled = bundledCatalog(options);
  const diagnostics: string[] = [];
  const cache = readCache(options.cacheFile ?? catalogCacheFile());
  if (cache) {
    const result = accept(cache.document, bundled.version, keys);
    if ('catalog' in result) return { catalog: result.catalog, source: 'cache', diagnostics };
    diagnostics.push(`Cached model catalog refused: ${result.refused}`);
  }
  return { catalog: bundled, source: 'bundled', diagnostics };
}

export interface RefreshOptions extends CatalogSourceOptions {
  fetch?: typeof fetch;
  url?: string;
  now?: number;
  timeoutMs?: number;
}

export type RefreshResult =
  | { status: 'fresh' }
  | { status: 'updated' | 'not-modified'; version: number }
  | { status: 'offline' | 'refused'; diagnostic: string };

/** Asks ClikDeploy for a newer catalog unless one was fetched in the last 24 hours. The request
 * carries only If-None-Match (the cache's ETag) and nothing about this machine. Never throws. */
export async function refreshCatalog(options: RefreshOptions = {}): Promise<RefreshResult> {
  const file = options.cacheFile ?? catalogCacheFile();
  const keys = options.keys ?? TRUSTED_CATALOG_KEYS;
  const now = options.now ?? Date.now();
  const loaded = loadCatalog(options);
  const cache = loaded.source === 'cache' ? readCache(file) : undefined;
  if (cache && now - cache.checkedAt < REFRESH_INTERVAL_MS) return { status: 'fresh' };
  try {
    const response = await (options.fetch ?? fetch)(options.url ?? CATALOG_URL, {
      headers: { Accept: 'application/json', ...(cache?.etag ? { 'If-None-Match': cache.etag } : {}) },
      signal: AbortSignal.timeout(options.timeoutMs ?? REFRESH_TIMEOUT_MS),
    });
    if (response.status === 304 && cache) {
      await writeCache(file, { ...cache, checkedAt: now });
      return { status: 'not-modified', version: loaded.catalog.version };
    }
    if (!response.ok) return { status: 'offline', diagnostic: `The model catalog server answered ${response.status}.` };
    const document: unknown = JSON.parse(await response.text());
    // Never go backwards, from a replayed older document either: the floor is the best held so far.
    const result = accept(document, loaded.catalog.version, keys);
    if ('refused' in result) return { status: 'refused', diagnostic: result.refused };
    const etag = response.headers.get('etag');
    await writeCache(file, { checkedAt: now, document, ...(etag ? { etag } : {}) });
    return { status: 'updated', version: result.catalog.version };
  } catch (error) {
    return { status: 'offline', diagnostic: `The model catalog could not be refreshed: ${message(error)}` };
  }
}

async function writeCache(file: string, cache: CatalogCache): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await atomicWriteFile(file, `${JSON.stringify(cache)}\n`, { durable: false });
}

// ---- the process's catalog ----------------------------------------------------

let current: LoadedCatalog | undefined;
let refreshing: Promise<void> | undefined;

/** The pinned models of the catalog in use, read once per process and replaced after a refresh. */
export function catalogModels(): readonly CatalogModel[] {
  current ??= loadCatalog();
  return current.catalog.models;
}

export function catalogDiagnostics(): readonly string[] {
  current ??= loadCatalog();
  return current.diagnostics;
}

/** Starts the daily refresh once per process, without waiting for it.
 * CLIKCODE_LOCAL_CATALOG_REFRESH=0 turns it off (tests, and air-gapped installs that want no request). */
export function startCatalogRefresh(): void {
  if (process.env.CLIKCODE_LOCAL_CATALOG_REFRESH === '0') return;
  refreshing ??= refreshCatalog().then((result) => {
    if (result.status === 'updated') current = loadCatalog();
  });
}

/** For tests: forget what this process loaded. */
export function resetCatalogForTests(): void {
  current = undefined;
  refreshing = undefined;
}
