import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REFERENCE_MISS_TTL_MS, recentMiss, rememberSearch } from './connector-reference-memo.js';

let dir = '';
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

describe('remembered reference searches', () => {
  it('keeps a miss for a week on the same homepage, and forgets it once a reference is found', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ref-memo-'));
    const t0 = Date.parse('2026-11-17T12:00:00Z');
    expect(await recentMiss(dir, 'acme', 'https://acme.example', t0)).toBeUndefined();
    await rememberSearch(dir, 'acme', 'https://acme.example', { applied: false, docsUrls: ['https://acme.example/docs'] }, t0);
    expect(await recentMiss(dir, 'acme', 'https://acme.example', t0 + 86_400_000)).toEqual({ at: '2026-11-17T12:00:00.000Z', homepage: 'https://acme.example', docsUrls: ['https://acme.example/docs'] });
    // Another homepage is a new search, and a week later the old miss no longer counts.
    expect(await recentMiss(dir, 'acme', 'https://www.acme.example', t0)).toBeUndefined();
    expect(await recentMiss(dir, 'acme', 'https://acme.example', t0 + REFERENCE_MISS_TTL_MS)).toBeUndefined();
    await rememberSearch(dir, 'acme', 'https://acme.example', { applied: true, docsUrls: [] }, t0 + 1);
    expect(await recentMiss(dir, 'acme', 'https://acme.example', t0 + 2)).toBeUndefined();
  });

  it('drops entries past their week when it writes', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ref-memo-'));
    const t0 = Date.parse('2026-11-01T00:00:00Z');
    await rememberSearch(dir, 'old', 'https://old.example', { applied: false, docsUrls: [] }, t0);
    await rememberSearch(dir, 'new', 'https://new.example', { applied: false, docsUrls: [] }, t0 + REFERENCE_MISS_TTL_MS + 1);
    const { readFile } = await import('node:fs/promises');
    expect(Object.keys(JSON.parse(await readFile(join(dir, 'computer', 'reference-search.json'), 'utf8')))).toEqual(['new']);
  });
});
