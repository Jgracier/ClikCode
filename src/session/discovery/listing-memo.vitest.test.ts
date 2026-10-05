import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_LISTING_TTL_MS, SEEN_LISTING_TTL_MS, freshListing, lastSeenListing, rememberListing, resetNativeSessionDiscoveryCache, saveDiscoveryCache,
} from './cache.js';

/**
 * Vendor `sessions list` commands cost a subprocess each and mostly find
 * nothing: measured here, /resume spent 2.5s spawning six, of which two took
 * 2.16s between them to return zero. Remembering "nothing here" skips the
 * spawn -- but only where that memo is actually true.
 */
describe('the empty-listing memo', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'clikcode-memo-'));
    process.env.CLIKCODE_HOME = home;
    resetNativeSessionDiscoveryCache();
  });

  afterEach(async () => {
    delete process.env.CLIKCODE_HOME;
    resetNativeSessionDiscoveryCache();
    await rm(home, { recursive: true, force: true });
  });

  it('remembers a harness that found nothing', async () => {
    expect(await freshListing('kilo', '/work', undefined)).toBeUndefined();
    await rememberListing('kilo', '/work', undefined, []);
    expect(await freshListing('kilo', '/work', undefined)).toEqual([]);
  });

  it('forgets the memo as soon as sessions appear', async () => {
    await rememberListing('kilo', '/work', undefined, []);
    await rememberListing('kilo', '/work', undefined, [{ nativeId: 'k1' }]);
    expect(await freshListing('kilo', '/work', undefined)).toEqual([{ nativeId: 'k1' }]);
  });

  it('does not let one account silence another', async () => {
    // Two accounts of the same provider have separate vendor stores. Keying
    // the memo on command+workspace alone would have hidden every session the
    // second account had, which is the bug this key exists to prevent.
    await rememberListing('hermes', '/work', '/profiles/a', []);
    expect(await freshListing('hermes', '/work', '/profiles/a')).toEqual([]);
    expect(await freshListing('hermes', '/work', '/profiles/b')).toBeUndefined();
  });

  it('does not let one workspace silence another', async () => {
    await rememberListing('kilo', '/work', undefined, []);
    expect(await freshListing('kilo', '/elsewhere', undefined)).toBeUndefined();
  });

  it('expires, so a session made elsewhere still turns up', async () => {
    const now = Date.now();
    await rememberListing('kilo', '/work', undefined, [], now);
    expect(await freshListing('kilo', '/work', undefined, now + EMPTY_LISTING_TTL_MS - 1)).toEqual([]);
    expect(await freshListing('kilo', '/work', undefined, now + EMPTY_LISTING_TTL_MS + 1)).toBeUndefined();
  });

  it('is not believed from another build', async () => {
    const now = Date.now();
    await rememberListing('kilo', '/work', undefined, [], now, 'kilo-1');
    expect(await freshListing('kilo', '/work', undefined, now + 1_000, 'kilo-2')).toBeUndefined();
  });

  it('is shared with a process that was already running when it was written', async () => {
    // A second module instance stands for another ClikCode window: it read
    // the cache before this answer existed, and must still see it.
    vi.resetModules();
    const other = await import('./cache.js');
    expect(await other.freshListing('hermes', '/work', undefined)).toBeUndefined();
    await rememberListing('hermes', '/work', undefined, [{ nativeId: 'h1' }]);
    expect(await other.freshListing('hermes', '/work', undefined)).toEqual([{ nativeId: 'h1' }]);
    // And its own answer does not drop this one when it writes.
    await other.rememberListing('opencode', '/work', undefined, []);
    expect(await freshListing('hermes', '/work', undefined)).toEqual([{ nativeId: 'h1' }]);
  });

  it('survives a restart, which is the point of writing it down', async () => {
    await rememberListing('kilo', '/work', undefined, []);
    await saveDiscoveryCache();
    resetNativeSessionDiscoveryCache();
    expect(await freshListing('kilo', '/work', undefined)).toEqual([]);
  });
});

describe('the last list each CLI gave', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'clikcode-seen-'));
    process.env.CLIKCODE_HOME = home;
    resetNativeSessionDiscoveryCache();
  });

  afterEach(async () => {
    delete process.env.CLIKCODE_HOME;
    resetNativeSessionDiscoveryCache();
    await rm(home, { recursive: true, force: true });
  });

  it('is kept across processes, so the next list shows it before asking again', async () => {
    await rememberListing('kilo', '/work', undefined, [{ nativeId: 'k1', title: 'Refactor' }]);
    await saveDiscoveryCache();
    resetNativeSessionDiscoveryCache();
    expect(await lastSeenListing('kilo', '/work', undefined)).toEqual([{ nativeId: 'k1', title: 'Refactor' }]);
  });

  it('is per folder and per account, like the listing itself', async () => {
    await rememberListing('hermes', '/work', '/profiles/a', [{ nativeId: 'h1' }]);
    expect(await lastSeenListing('hermes', '/work', '/profiles/b')).toEqual([]);
    expect(await lastSeenListing('hermes', '/other', '/profiles/a')).toEqual([]);
  });

  it('is replaced by the next answer, and cleared when that answer is empty', async () => {
    await rememberListing('opencode', '/work', undefined, [{ nativeId: 'o1' }]);
    await rememberListing('opencode', '/work', undefined, [{ nativeId: 'o2' }]);
    expect(await lastSeenListing('opencode', '/work', undefined)).toEqual([{ nativeId: 'o2' }]);
    await rememberListing('opencode', '/work', undefined, []);
    expect(await lastSeenListing('opencode', '/work', undefined)).toEqual([]);
  });

  it('reuses a list for two minutes, then asks the CLI again', async () => {
    const now = Date.now();
    await rememberListing('kilo', '/work', undefined, [{ nativeId: 'k1' }], now, 'kilo-1');
    expect(await freshListing('kilo', '/work', undefined, now + 1_000, 'kilo-1')).toEqual([{ nativeId: 'k1' }]);
    expect(await freshListing('kilo', '/work', undefined, now + SEEN_LISTING_TTL_MS + 1, 'kilo-1')).toBeUndefined();
    // A new binary is asked at once.
    expect(await freshListing('kilo', '/work', undefined, now + 1_000, 'kilo-2')).toBeUndefined();
  });
});
