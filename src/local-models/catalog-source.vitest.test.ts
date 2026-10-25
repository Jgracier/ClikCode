import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import snapshot from './catalog.snapshot.json' with { type: 'json' };
import { CATALOG_URL, loadCatalog, refreshCatalog, REFRESH_INTERVAL_MS, TRUSTED_CATALOG_KEYS, type CatalogCache } from './catalog-source';
import { canonicalJson, signLocalCatalog, trustedKeyFrom } from './shared/catalog-signature';
import type { LocalCatalog } from './shared/index';

const DAY = REFRESH_INTERVAL_MS;
const NOW = Date.parse('2026-11-01T00:00:00Z');

function newKey(): { pem: string; trusted: ReturnType<typeof trustedKeyFrom> } {
  const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  return { pem, trusted: trustedKeyFrom(pem) };
}

const signer = newKey();
const baseCatalog = (snapshot as unknown as { catalog: LocalCatalog }).catalog;

/** A catalog signed with the test key, at `version`, whose first model is renamed so a read shows which source won. */
function signed(version: number, key = signer, label = `v${version}`): ReturnType<typeof signLocalCatalog> {
  const models = baseCatalog.models.map((model, index) => (index === 0 ? { ...model, label } : model));
  return signLocalCatalog({ ...baseCatalog, version, models }, key.pem);
}

let dir: string;
let cacheFile: string;
const bundled = (): ReturnType<typeof signed> => signed(5, signer, 'bundled');
const options = () => ({ cacheFile, keys: [signer.trusted], bundled: bundled() });
const firstLabel = (catalog: LocalCatalog): string => catalog.models[0]!.label;

function writeCache(document: unknown, checkedAt: number, etag?: string): void {
  const cache: CatalogCache = { checkedAt, document, ...(etag ? { etag } : {}) };
  writeFileSync(cacheFile, JSON.stringify(cache));
}

function respond(body: unknown, init: { status?: number; etag?: string } = {}): typeof fetch {
  return vi.fn(async () => new Response(init.status === 304 ? null : JSON.stringify(body), {
    status: init.status ?? 200, headers: init.etag ? { ETag: init.etag } : {},
  })) as unknown as typeof fetch;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'catalog-source-'));
  cacheFile = join(dir, 'catalog-cache.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the bundled snapshot', () => {
  it('verifies against the embedded public key', () => {
    const loaded = loadCatalog({ cacheFile });
    expect(loaded.source).toBe('bundled');
    expect(loaded.catalog.models.length).toBeGreaterThan(0);
    expect(TRUSTED_CATALOG_KEYS.map((key) => key.keyId)).toContain((snapshot as { signature: { keyId: string } }).signature.keyId);
  });

  it('is refused, not read, when it does not verify', () => {
    const tampered = structuredClone(bundled());
    tampered.catalog.models[0]!.weights.sha256 = 'a'.repeat(64);
    expect(() => loadCatalog({ ...options(), bundled: tampered })).toThrow(/signature does not match/);
  });
});

describe('reading the catalog', () => {
  it('uses the bundled snapshot with no cache (a fresh offline install)', () => {
    const loaded = loadCatalog(options());
    expect(loaded).toMatchObject({ source: 'bundled', diagnostics: [] });
    expect(firstLabel(loaded.catalog)).toBe('bundled');
  });

  it('prefers a valid cache that is not older than the bundled version', () => {
    writeCache(signed(6), NOW);
    const loaded = loadCatalog(options());
    expect(loaded.source).toBe('cache');
    expect(loaded.catalog.version).toBe(6);
  });

  it('still reads a stale cache: offline keeps working with the last verified catalog', () => {
    writeCache(signed(7), NOW - 30 * DAY);
    expect(loadCatalog(options()).catalog.version).toBe(7);
  });

  it('refuses a tampered cache and falls back to the bundled snapshot with a diagnostic', () => {
    const document = signed(6);
    document.catalog.models[0]!.weights.sizeBytes += 1;
    writeCache(document, NOW);
    const loaded = loadCatalog(options());
    expect(loaded.source).toBe('bundled');
    expect(loaded.diagnostics[0]).toMatch(/Cached model catalog refused: .*signature does not match/);
  });

  it('refuses a cache signed by a key it does not trust', () => {
    writeCache(signed(9, newKey()), NOW);
    const loaded = loadCatalog(options());
    expect(loaded.source).toBe('bundled');
    expect(loaded.diagnostics[0]).toMatch(/unknown key/);
  });

  it('refuses a cache older than the bundled version', () => {
    writeCache(signed(4), NOW);
    const loaded = loadCatalog(options());
    expect(loaded.source).toBe('bundled');
    expect(loaded.diagnostics[0]).toMatch(/older than the 5/);
  });

  it('refuses an unsigned cache and an unknown schema', () => {
    writeCache({ catalog: baseCatalog }, NOW);
    expect(loadCatalog(options())).toMatchObject({ source: 'bundled', diagnostics: [expect.stringMatching(/no Ed25519 signature/)] });
    // Correctly signed, but a schema this reader does not know.
    const future = { ...baseCatalog, schema: 2, version: 8 };
    const value = sign(null, Buffer.from(canonicalJson(future)), createPrivateKey(signer.pem)).toString('base64');
    writeCache({ catalog: future, signature: { algorithm: 'ed25519', keyId: signer.trusted.keyId, value } }, NOW);
    expect(loadCatalog(options())).toMatchObject({ source: 'bundled', diagnostics: [expect.stringMatching(/schema must be 1/)] });
  });

  it('treats a damaged cache file as absent', () => {
    writeFileSync(cacheFile, '{ not json');
    expect(loadCatalog(options()).source).toBe('bundled');
  });
});

describe('refreshing the catalog', () => {
  it('fetches and caches a newer signed catalog, sending nothing about the machine', async () => {
    const fetcher = respond(signed(6), { etag: '"abc"' });
    const result = await refreshCatalog({ ...options(), fetch: fetcher, now: NOW });
    expect(result).toEqual({ status: 'updated', version: 6 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetcher).mock.calls[0]!;
    expect(url).toBe(CATALOG_URL);
    expect(Object.keys((init as RequestInit).headers as Record<string, string>)).toEqual(['Accept']);
    expect(JSON.parse(readFileSync(cacheFile, 'utf8'))).toMatchObject({ checkedAt: NOW, etag: '"abc"' });
    expect(loadCatalog(options()).catalog.version).toBe(6);
  });

  it('does not ask again within 24 hours', async () => {
    writeCache(signed(6), NOW - DAY / 2, '"abc"');
    const fetcher = respond(signed(7));
    expect(await refreshCatalog({ ...options(), fetch: fetcher, now: NOW })).toEqual({ status: 'fresh' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('asks again after 24 hours, with the cache\'s ETag, and a 304 only renews the check time', async () => {
    writeCache(signed(6), NOW - DAY - 1, '"abc"');
    const fetcher = respond(null, { status: 304 });
    expect(await refreshCatalog({ ...options(), fetch: fetcher, now: NOW })).toEqual({ status: 'not-modified', version: 6 });
    expect(vi.mocked(fetcher).mock.calls[0]![1]!.headers).toMatchObject({ 'If-None-Match': '"abc"' });
    expect(JSON.parse(readFileSync(cacheFile, 'utf8'))).toMatchObject({ checkedAt: NOW, etag: '"abc"' });
    expect(await refreshCatalog({ ...options(), fetch: fetcher, now: NOW + 1000 })).toEqual({ status: 'fresh' });
  });

  it('stays on the cached catalog when offline, and tries again next time', async () => {
    writeCache(signed(6), NOW - 2 * DAY, '"abc"');
    const failing = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const result = await refreshCatalog({ ...options(), fetch: failing, now: NOW });
    expect(result).toMatchObject({ status: 'offline', diagnostic: expect.stringContaining('fetch failed') });
    expect(loadCatalog(options()).catalog.version).toBe(6);
    expect(JSON.parse(readFileSync(cacheFile, 'utf8')).checkedAt).toBe(NOW - 2 * DAY);
  });

  it('treats a server error as offline and leaves the cache alone', async () => {
    const result = await refreshCatalog({ ...options(), fetch: respond({}, { status: 503 }), now: NOW });
    expect(result).toMatchObject({ status: 'offline' });
    expect(() => readFileSync(cacheFile)).toThrow();
  });

  it('refuses a tampered body and caches nothing', async () => {
    const body = signed(6);
    body.catalog.models[0]!.label = 'evil';
    const result = await refreshCatalog({ ...options(), fetch: respond(body), now: NOW });
    expect(result).toMatchObject({ status: 'refused', diagnostic: expect.stringMatching(/signature does not match/) });
    expect(() => readFileSync(cacheFile)).toThrow();
  });

  it('refuses a catalog signed by the wrong key', async () => {
    const result = await refreshCatalog({ ...options(), fetch: respond(signed(6, newKey())), now: NOW });
    expect(result).toMatchObject({ status: 'refused', diagnostic: expect.stringMatching(/unknown key/) });
  });

  it('refuses a replayed older catalog, below the bundled and below the cached version', async () => {
    expect(await refreshCatalog({ ...options(), fetch: respond(signed(4)), now: NOW })).toMatchObject({ status: 'refused' });
    writeCache(signed(8), NOW - 2 * DAY);
    expect(await refreshCatalog({ ...options(), fetch: respond(signed(7)), now: NOW })).toMatchObject({ status: 'refused' });
    expect(loadCatalog(options()).catalog.version).toBe(8);
  });

  it('replaces a refused cache with a good download', async () => {
    writeCache({ catalog: baseCatalog }, NOW);
    const fetcher = respond(signed(6), { etag: '"new"' });
    expect(await refreshCatalog({ ...options(), fetch: fetcher, now: NOW })).toEqual({ status: 'updated', version: 6 });
    expect(vi.mocked(fetcher).mock.calls[0]![1]!.headers).not.toHaveProperty('If-None-Match');
  });
});
