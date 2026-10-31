import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { janitorTick, measureBrowser, recycleFile, recycleLimits, recycleVerdict, restoreTabs, takeRecycle, tabsToRestore } from './browser-janitor.js';
import { readTabRecords, writeTabRecord, type TabRecord } from './tab-registry.js';

const GIB = 2 ** 30;
const now = 10_000_000_000;
const rec = (id: string, over: Partial<TabRecord> = {}): TabRecord => ({ id, ownerPid: process.pid, owner: 'worker', openedAt: now - 3_600_000, lastUsedAt: now - 60_000, url: `https://x.test/${id}`, tab: id, ...over });

describe('recycleVerdict', () => {
  const limits = recycleLimits({});
  it('defaults to 40 renderers or 6 GB', () => {
    expect(limits).toEqual({ renderers: 40, bytes: 6 * GIB });
    expect(recycleLimits({ CLIKCODE_BROWSER_MAX_RENDERERS: '10', CLIKCODE_BROWSER_MAX_GB: '2' })).toEqual({ renderers: 10, bytes: 2 * GIB });
  });
  it('is quiet under both ceilings', () => { expect(recycleVerdict({ renderers: 39, bytes: 5 * GIB }, limits, 0, now)).toBeUndefined(); });
  it('names what went over', () => {
    expect(recycleVerdict({ renderers: 41, bytes: GIB }, limits, 0, now)).toMatch(/41 renderers over 40/);
    expect(recycleVerdict({ renderers: 3, bytes: 7 * GIB }, limits, 0, now)).toMatch(/7.0 GB over 6.0 GB/);
  });
  it('waits while a tab is in use, unless far over', () => {
    expect(recycleVerdict({ renderers: 41, bytes: GIB }, limits, now - 2_000, now)).toBeUndefined();
    expect(recycleVerdict({ renderers: 90, bytes: GIB }, limits, now - 2_000, now)).toMatch(/90 renderers/);
  });
});

describe('what comes back after a recycle', () => {
  it('keeps only named tabs used in the last 10 minutes, newest per name, never a parked one', () => {
    const saved = tabsToRestore([
      rec('a', { lastUsedAt: now - 2 * 60_000 }), rec('b', { lastUsedAt: now - 11 * 60_000 }), rec('c', { parked: true }),
      { ...rec('d'), tab: undefined }, rec('e', { url: 'about:blank' }), rec('a2', { tab: 'a', lastUsedAt: now - 5 * 60_000 }),
    ], now);
    expect(saved).toEqual([{ tab: 'a', url: 'https://x.test/a' }]);
  });
});

describe('measureBrowser', () => {
  it('counts renderers below the host and sums proportional memory', () => {
    const files: Record<string, Record<string, string>> = {
      '10': { stat: '10 (node) S 1 ', cmdline: 'node\0computer-host', smaps_rollup: 'Pss:    1000 kB\n', cgroup: '0::/x\n' },
      '11': { stat: '11 (chrome) S 10 ', cmdline: 'chrome\0--no-sandbox', smaps_rollup: 'Pss:    2000 kB\n' },
      '12': { stat: '12 (chrome) S 11 ', cmdline: 'chrome\0--type=renderer', smaps_rollup: 'Pss:    3000 kB\n' },
      '13': { stat: '13 (chrome) S 11 ', cmdline: 'chrome\0--type=renderer', statm: '1 100 0 0 0 0 0' },
      '99': { stat: '99 (other) S 1 ', cmdline: 'chrome\0--type=renderer', smaps_rollup: 'Pss:    9999 kB\n' },
    };
    const proc = { list: () => Object.keys(files), read: (pid: number, file: string) => files[String(pid)]?.[file] };
    expect(measureBrowser(10, proc, () => undefined)).toEqual({ renderers: 2, bytes: (1000 + 2000 + 3000) * 1024 + 100 * 4096 });
    expect(measureBrowser(10, proc, () => 5 * GIB)).toEqual({ renderers: 2, bytes: 5 * GIB });
  });
});

describe('with a state directory', () => {
  let stateDir: string;
  beforeEach(async () => { stateDir = await mkdtemp(path.join(tmpdir(), 'janitor-')); });
  afterEach(async () => { await rm(stateDir, { recursive: true, force: true }); });

  it('over a ceiling: saves the recent named tabs and ends the browser; the next host reopens them as unclaimed records', async () => {
    await writeTabRecord(stateDir, rec('recent', { lastUsedAt: Date.now() - 120_000 }));
    await writeTabRecord(stateDir, rec('stale', { lastUsedAt: Date.now() - 30 * 60_000 }));
    let recycled = 0;
    const reason = await janitorTick({
      stateDir, hostPid: 1, recycle: async () => { recycled++; },
      measure: () => ({ renderers: 41, bytes: GIB }), limits: recycleLimits({}),
    });
    expect(reason).toMatch(/41 renderers/);
    expect(recycled).toBe(1);
    expect(JSON.parse(await readFile(recycleFile(stateDir), 'utf8')).tabs).toEqual([{ tab: 'recent', url: 'https://x.test/recent' }]);

    const opened: string[] = [];
    const count = await restoreTabs(stateDir, await takeRecycle(stateDir), { openPage: async url => { opened.push(url); return `new-${opened.length}`; } });
    expect(count).toBe(1);
    expect(opened).toEqual(['https://x.test/recent']);
    const restored = (await readTabRecords(stateDir)).find(r => r.id === 'new-1')!;
    expect(restored).toMatchObject({ tab: 'recent', ownerPid: 0, restoreFor: 'recent' });
    expect(await takeRecycle(stateDir)).toEqual([]);
  });

  it('under both ceilings: no recycle', async () => {
    let recycled = 0;
    const reason = await janitorTick({ stateDir, hostPid: 1, recycle: async () => { recycled++; }, measure: () => ({ renderers: 5, bytes: GIB }) });
    expect(reason).toBeUndefined();
    expect(recycled).toBe(0);
  });
});
