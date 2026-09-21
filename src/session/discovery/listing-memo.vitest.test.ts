import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_LISTING_TTL_MS, listingKnownEmpty, rememberListing, resetNativeSessionDiscoveryCache, saveDiscoveryCache,
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
    expect(await listingKnownEmpty('kilo', '/work', undefined)).toBe(false);
    await rememberListing('kilo', '/work', undefined, 0);
    expect(await listingKnownEmpty('kilo', '/work', undefined)).toBe(true);
  });

  it('never memoizes a harness that found something', async () => {
    await rememberListing('hermes', '/work', undefined, 8);
    expect(await listingKnownEmpty('hermes', '/work', undefined)).toBe(false);
  });

  it('forgets the memo as soon as sessions appear', async () => {
    await rememberListing('kilo', '/work', undefined, 0);
    await rememberListing('kilo', '/work', undefined, 2);
    expect(await listingKnownEmpty('kilo', '/work', undefined)).toBe(false);
  });

  it('does not let one account silence another', async () => {
    // Two accounts of the same provider have separate vendor stores. Keying
    // the memo on command+workspace alone would have hidden every session the
    // second account had, which is the bug this key exists to prevent.
    await rememberListing('hermes', '/work', '/profiles/a', 0);
    expect(await listingKnownEmpty('hermes', '/work', '/profiles/a')).toBe(true);
    expect(await listingKnownEmpty('hermes', '/work', '/profiles/b')).toBe(false);
  });

  it('does not let one workspace silence another', async () => {
    await rememberListing('kilo', '/work', undefined, 0);
    expect(await listingKnownEmpty('kilo', '/elsewhere', undefined)).toBe(false);
  });

  it('expires, so a session made elsewhere still turns up', async () => {
    const now = Date.now();
    await rememberListing('kilo', '/work', undefined, 0, now);
    expect(await listingKnownEmpty('kilo', '/work', undefined, now + EMPTY_LISTING_TTL_MS - 1)).toBe(true);
    expect(await listingKnownEmpty('kilo', '/work', undefined, now + EMPTY_LISTING_TTL_MS + 1)).toBe(false);
  });

  it('survives a restart, which is the point of writing it down', async () => {
    await rememberListing('kilo', '/work', undefined, 0);
    await saveDiscoveryCache();
    resetNativeSessionDiscoveryCache();
    expect(await listingKnownEmpty('kilo', '/work', undefined)).toBe(true);
  });
});
