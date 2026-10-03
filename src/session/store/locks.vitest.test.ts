import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { readlinkSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCK_TUNING, breakStaleLock, lockLooksStale, withFileLock } from './locks.js';
import { runChild } from '../state/testing/concurrency.js';

let root: string | undefined;
const defaults = { ...LOCK_TUNING };

afterEach(async () => {
  Object.assign(LOCK_TUNING, defaults);
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const ourPidns = (() => { try { return readlinkSync('/proc/self/ns/pid'); } catch { return undefined; } })();
const owner = (extra: Record<string, unknown>) => JSON.stringify({ pid: 2 ** 22 + 7, host: hostname(), nonce: 'n', at: new Date().toISOString(), ...extra });
const age = async (path: string, ms: number) => { const then = new Date(Date.now() - ms); await utimes(path, then, then); };

describe('withFileLock', () => {
  it('a promise started inside a locked section, and left running, waits for the section to release', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-locks-'));
    const path = join(root, 'a.lock');
    const order: string[] = [];
    let detached: Promise<void> | undefined;
    await withFileLock(path, async () => {
      order.push('outer-start');
      detached = withFileLock(path, async () => { order.push('detached'); });
      await tick(20);
      order.push('outer-end');
    });
    await detached;
    expect(order).toEqual(['outer-start', 'outer-end', 'detached']);
  });

  it('serializes sibling tasks of one chain against each other', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-locks-'));
    const path = join(root, 'b.lock');
    const order: string[] = [];
    const task = (name: string, holdMs: number) => withFileLock(path, async () => {
      order.push(`${name}-start`);
      await tick(holdMs);
      order.push(`${name}-end`);
    });
    await Promise.all([task('a', 20), task('b', 0)]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('leaves no lock file behind, on success or error', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-locks-'));
    const path = join(root, 'c.lock');
    await withFileLock(path, async () => undefined);
    await expect(readFile(path, 'utf8')).rejects.toThrow();
    await expect(withFileLock(path, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(readFile(path, 'utf8')).rejects.toThrow();
  });

  it('keeps a long-held lock fresh with a heartbeat, up to the hold limit', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-locks-'));
    const path = join(root, 'd.lock');
    Object.assign(LOCK_TUNING, { staleMs: 200, heartbeatMs: 30, maxHoldMs: 700 });
    await withFileLock(path, async () => {
      await tick(450);
      expect(await lockLooksStale(path, await readFile(path, 'utf8'))).toBe(false);
      await tick(700);
      // Past maxHoldMs the heartbeat stopped: a stuck holder is breakable.
      expect(await lockLooksStale(path, await readFile(path, 'utf8'))).toBe(true);
    });
  });

  it('times out instead of waiting forever behind a stuck holder in this process', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-locks-'));
    const path = join(root, 'e.lock');
    Object.assign(LOCK_TUNING, { waitMs: 50, maxHoldMs: 50 });
    let release!: () => void;
    const stuck = withFileLock(path, () => new Promise<void>((resolve) => { release = resolve; }));
    await expect(withFileLock(path, async () => 'ran')).rejects.toThrow(/could not lock/);
    release();
    await stuck;
  });
});

describe('judging a lock someone else holds', () => {
  it('does not break a fresh lock whose pid is merely invisible (another pid namespace)', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-locks-'));
    const path = join(root, 'f.lock');
    const raw = owner({ pidns: 'pid:[1]' });
    await writeFile(path, raw);
    expect(await lockLooksStale(path, raw)).toBe(false);
    await age(path, LOCK_TUNING.staleMs + 1_000);
    expect(await lockLooksStale(path, raw)).toBe(true);
  });

  it('breaks at once a lock whose owner is visibly dead: same host, same namespace (or an older build\'s)', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-locks-'));
    const path = join(root, 'g.lock');
    const raws = [owner({}), ...(ourPidns ? [owner({ pidns: ourPidns })] : [])];
    for (const raw of raws) {
      await writeFile(path, raw);
      expect(await lockLooksStale(path, raw)).toBe(true);
    }
    const live = owner({ pid: process.pid, ...(ourPidns ? { pidns: ourPidns } : {}) });
    await writeFile(path, live);
    expect(await lockLooksStale(path, live)).toBe(false);
  });

  it('never removes a lock that is not the one judged, or no longer stale', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-locks-'));
    const path = join(root, 'h.lock');
    const judged = owner({ nonce: 'old' });
    const fresh = owner({ nonce: 'fresh', pid: process.pid });
    await writeFile(path, fresh);
    await breakStaleLock(path, judged);
    expect(await readFile(path, 'utf8')).toBe(fresh);
    await breakStaleLock(path, fresh, async () => false);
    expect(await readFile(path, 'utf8')).toBe(fresh);
    await breakStaleLock(path, fresh, async () => true);
    await expect(stat(path)).rejects.toThrow();
  });

  it('separate processes contending on a lock that starts stale: never two holders', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-locks-'));
    const path = join(root, 'i.lock');
    for (let round = 0; round < 3; round += 1) {
      await writeFile(path, owner({ nonce: `dead-${round}` }));
      await age(path, LOCK_TUNING.staleMs + 1_000);
      const results = await Promise.all(Array.from({ length: 4 }, () => runChild(root!, ['contend', path, '', '25'])));
      for (const result of results) expect(result, result.stderr).toMatchObject({ code: 0 });
    }
  }, 120_000);
});
