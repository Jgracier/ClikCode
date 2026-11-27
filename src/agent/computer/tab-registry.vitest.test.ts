import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allTabs, closeTabsByLabel, closeTabsOfOwner, describeTabs, planTabClosures, readTabRecords, sweepTabs, tabLimits, writeTabRecord, type BrowserTarget, type TabRecord } from './tab-registry.js';

const MIN = 60_000;
const now = 10_000_000_000;
const limits = { idleMs: 20 * MIN, maxTabs: 3 };
const rec = (id: string, over: Partial<TabRecord> = {}): TabRecord => ({ id, ownerPid: 100, owner: 'worker 100', openedAt: now - 5 * MIN, lastUsedAt: now - MIN, url: `https://x.test/${id}`, ...over });

describe('planTabClosures', () => {
  const plan = (records: TabRecord[], alive: (pid: number) => boolean = () => true, l = limits) =>
    planTabClosures({ records, liveIds: new Set(records.map(r => r.id)), now, limits: l, alive });

  it('closes a tab whose owner process has ended', () => {
    expect(plan([rec('a', { ownerPid: 7 }), rec('b')], pid => pid !== 7).close).toEqual([{ id: 'a', reason: 'owner ended' }]);
  });
  it('closes a tab idle past the limit and keeps a recent one', () => {
    expect(plan([rec('old', { lastUsedAt: now - 21 * MIN }), rec('new')]).close).toEqual([{ id: 'old', reason: 'idle' }]);
  });
  it('past the cap evicts the least recently used first, never a tab used seconds ago', () => {
    const records = [rec('a', { lastUsedAt: now - 5 * MIN }), rec('b', { lastUsedAt: now - 9 * MIN }), rec('c', { lastUsedAt: now - 2_000 }), rec('d', { lastUsedAt: now - 7 * MIN }), rec('e', { lastUsedAt: now - 3 * MIN })];
    expect(plan(records).close).toEqual([{ id: 'b', reason: 'over the tab cap' }, { id: 'd', reason: 'over the tab cap' }]);
  });
  it('past the cap takes unrecorded and ownerless tabs before live owners\' tabs', () => {
    const records = [rec('live-old', { ownerPid: 1, tab: 'a', lastUsedAt: now - 9 * MIN }), rec('live-spare', { ownerPid: 1, tab: 'a', lastUsedAt: now - 8 * MIN }),
      rec('stray', { ownerPid: 0, unrecorded: true, openedAt: now - 15_000, lastUsedAt: now - 15_000 }), rec('restored', { ownerPid: 0, restoreFor: 'x', lastUsedAt: now - MIN }),
      rec('other', { ownerPid: 2, tab: 'b', lastUsedAt: now - 7 * MIN })];
    expect(plan(records, () => true, { ...limits, maxTabs: 2 }).close).toEqual([
      { id: 'stray', reason: 'over the tab cap' }, { id: 'restored', reason: 'over the tab cap' }, { id: 'live-old', reason: 'over the tab cap' }]);
  });
  it('never closes a running owner\'s working tab for the cap, even far over it', () => {
    const records = Array.from({ length: 6 }, (_, i) => rec(`w${i}`, { ownerPid: 10 + i, tab: 'grant', lastUsedAt: now - (i + 1) * 15_000 }));
    expect(plan(records, () => true, { ...limits, maxTabs: 2 }).close).toEqual([]);
  });
  it('closes an unrecorded page once the grace has passed, whatever the cap', () => {
    expect(plan([rec('s', { ownerPid: 0, unrecorded: true, openedAt: now - 31_000, lastUsedAt: now - 31_000 })]).close).toEqual([{ id: 's', reason: 'not recorded' }]);
    expect(plan([rec('s', { ownerPid: 0, unrecorded: true, openedAt: now - 5_000, lastUsedAt: now - 5_000 })]).close).toEqual([]);
  });
  it('never closes the host\'s anchor page while the host lives, and does not count it toward the cap', () => {
    const anchor = rec('anchor', { ownerPid: 9, tab: 'browser-host', anchor: true, lastUsedAt: now - 5 * 3_600_000, url: 'about:blank' });
    const records = [anchor, rec('a', { ownerPid: 1, tab: 'a' }), rec('b', { ownerPid: 2, tab: 'b' })];
    expect(plan(records, () => true, { ...limits, maxTabs: 2 }).close).toEqual([]);
    expect(plan([anchor], pid => pid !== 9).close).toEqual([{ id: 'anchor', reason: 'owner ended' }]);
  });
  it('forgets a record whose page is gone without closing anything', () => {
    const result = planTabClosures({ records: [rec('gone')], liveIds: new Set(), now, limits, alive: () => true });
    expect(result).toEqual({ close: [], forget: ['gone'] });
  });
  it('leaves a parked tab alone for its owner ending or a short idle, but not for ever', () => {
    expect(plan([rec('p', { parked: true, ownerPid: 0, lastUsedAt: now - 3 * 3_600_000 })]).close).toEqual([]);
    expect(plan([rec('p', { parked: true, ownerPid: 0, lastUsedAt: now - 7 * 3_600_000 })]).close).toEqual([{ id: 'p', reason: 'idle' }]);
  });
  it('does not close a restored, unclaimed tab for having no owner process', () => {
    expect(plan([rec('r', { ownerPid: 0, restoreFor: 'main' })]).close).toEqual([]);
  });
});

describe('tabLimits', () => {
  it('defaults to 20 minutes and 12 tabs, and reads the environment', () => {
    expect(tabLimits({})).toEqual({ idleMs: 20 * MIN, maxTabs: 12 });
    expect(tabLimits({ CLIKCODE_BROWSER_TAB_IDLE_MS: '1000', CLIKCODE_BROWSER_MAX_TABS: '4' })).toEqual({ idleMs: 1000, maxTabs: 4 });
  });
});

describe('sweeping a browser', () => {
  let stateDir: string;
  beforeEach(async () => { stateDir = await mkdtemp(path.join(tmpdir(), 'tabs-')); });
  afterEach(async () => { await rm(stateDir, { recursive: true, force: true }); });

  const browser = (ids: string[]) => {
    const live = new Set(ids);
    const closed: string[] = [];
    return {
      closed,
      list: async (): Promise<BrowserTarget[]> => [...live].map(id => ({ id, type: 'page', url: `https://x.test/${id}`, title: `T ${id}` })),
      close: async (id: string): Promise<boolean> => { live.delete(id); closed.push(id); return true; },
    };
  };

  it('closes the tabs of an ended worker and an idle tab, keeps the rest, and drops their records', async () => {
    await writeTabRecord(stateDir, rec('dead', { ownerPid: 7, tab: 'sub-agent-1' }));
    await writeTabRecord(stateDir, rec('idle', { lastUsedAt: now - 30 * MIN, tab: 'research' }));
    await writeTabRecord(stateDir, rec('fresh', { tab: 'main' }));
    const fake = browser(['dead', 'idle', 'fresh']);
    const done = await sweepTabs(stateDir, { now, limits, alive: pid => pid !== 7, list: fake.list, close: fake.close });
    expect(done.map(entry => [entry.view.id, entry.reason])).toEqual([['dead', 'owner ended'], ['idle', 'idle']]);
    expect((await readTabRecords(stateDir)).map(r => r.id)).toEqual(['fresh']);
  });

  it('gives a tab nobody recorded a stand-in on disk, so a later sweep in any process closes it after the grace', async () => {
    const fake = browser(['stray-1', 'mine']);
    await writeTabRecord(stateDir, rec('mine', { tab: 'main' }));
    expect(await sweepTabs(stateDir, { now, limits, list: fake.list, close: fake.close })).toEqual([]);
    expect((await readTabRecords(stateDir)).find(r => r.id === 'stray-1')).toMatchObject({ unrecorded: true, openedAt: now });
    expect(await sweepTabs(stateDir, { now: now + 10_000, limits, list: fake.list, close: fake.close })).toEqual([]);
    const later = await sweepTabs(stateDir, { now: now + 31_000, limits, list: fake.list, close: fake.close });
    expect(later.map(entry => [entry.view.id, entry.reason])).toEqual([['stray-1', 'not recorded']]);
    expect(fake.closed).toEqual(['stray-1']);
  });

  it('never replaces a worker\'s own record with a stand-in', async () => {
    await writeTabRecord(stateDir, rec('a', { tab: 'main', ownerPid: 555 }));
    const fake = browser(['a', 'b']);
    await sweepTabs(stateDir, { now, limits, list: fake.list, close: fake.close });
    const records = await readTabRecords(stateDir);
    expect(records.find(r => r.id === 'a')).toMatchObject({ ownerPid: 555, tab: 'main' });
    expect(records.find(r => r.id === 'a')?.unrecorded).toBeUndefined();
  });

  it('never closes the last page', async () => {
    const fake = browser(['stray-1']);
    await sweepTabs(stateDir, { now, limits, list: fake.list, close: fake.close });
    expect(await sweepTabs(stateDir, { now: now + 25 * MIN, limits, list: fake.list, close: fake.close })).toEqual([]);
    expect(fake.closed).toEqual([]);
  });

  it('lists every tab with owner, age and idle time, not only the caller\'s', async () => {
    await writeTabRecord(stateDir, rec('a', { tab: 'worker-a', owner: 'worker 41 (session abc)', openedAt: now - 3 * 3_600_000, lastUsedAt: now - 2 * 3_600_000 }));
    await writeTabRecord(stateDir, rec('b', { tab: 'worker-b', ownerPid: 0, parked: true }));
    const fake = browser(['a', 'b', 'c']);
    const views = (await allTabs(stateDir, { now, list: fake.list }))!;
    expect(views).toHaveLength(3);
    const text = describeTabs(views, now, { limits });
    expect(text).toContain('tab "worker-a" · worker 41 (session abc) · open 3h, idle 2h');
    expect(text).toContain('parked');
    expect(text).toContain('not recorded');
  });

  it('says nothing is listed when the browser is not running', async () => {
    expect(await allTabs(stateDir, { list: async () => undefined })).toBeUndefined();
  });

  it('closes a named tab whoever holds it, and every tab of one owner', async () => {
    await writeTabRecord(stateDir, rec('a', { tab: 'x', ownerPid: 555 }));
    await writeTabRecord(stateDir, rec('b', { tab: 'y', ownerPid: 666 }));
    await writeTabRecord(stateDir, rec('c', { tab: 'z', ownerPid: 666 }));
    const fake = browser(['a', 'b', 'c']);
    expect((await closeTabsByLabel(stateDir, 'x', { now, list: fake.list, close: fake.close })).map(v => v.id)).toEqual(['a']);
    expect(await closeTabsOfOwner(stateDir, 666, { now, list: fake.list, close: fake.close })).toBe(2);
    expect(fake.closed).toEqual(['a', 'b', 'c']);
  });
  it('leaves the host\'s anchor page out of a close by name, by owner, and out of the listing', async () => {
    await writeTabRecord(stateDir, rec('anchor', { tab: 'browser-host', ownerPid: 777, anchor: true, url: 'about:blank' }));
    await writeTabRecord(stateDir, rec('a', { tab: 'x', ownerPid: 555 }));
    const fake = browser(['anchor', 'a']);
    expect(await closeTabsByLabel(stateDir, 'browser-host', { now, list: fake.list, close: fake.close })).toEqual([]);
    expect(await closeTabsOfOwner(stateDir, 777, { now, list: fake.list, close: fake.close })).toBe(0);
    const text = describeTabs((await allTabs(stateDir, { now, list: fake.list }))!, now, { limits });
    expect(text).not.toContain('browser-host');
    expect(text).toContain('(1;');
    expect(fake.closed).toEqual([]);
  });
});
