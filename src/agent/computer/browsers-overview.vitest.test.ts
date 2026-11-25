import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { browsersOverview, browsersText, forgetWatchView, pickTab, processAgeMs, recordWatchView, watchViews } from './browsers-overview.js';
import type { TabView } from './tab-registry.js';

const NOW = 10_000_000;
const view = (change: Partial<TabView>): TabView => ({ id: 'AAAA1111', ownerPid: 0, owner: 'worker 1', openedAt: NOW - 600_000, lastUsedAt: NOW - 30_000, url: 'https://example.com/', recorded: true, ...change });

describe('the browsers list', () => {
  const deps = {
    now: NOW,
    tabs: async () => [
      view({ id: 'AAAA1111', tab: 'signup', ownerPid: 41, owner: 'worker 41 (session 9d0c4a35)', url: 'https://signin.aws.amazon.com/oauth?code=SECRET&state=x', title: 'Sign in', liveView: 'http://127.0.0.1:5000/t/' }),
      view({ id: 'BBBB2222', ownerPid: 0, owner: 'parked by worker 7', parked: true, egress: 'prod', url: 'https://dash.example.com/keys' }),
      view({ id: 'CCCC3333', owner: 'not recorded (opened before tracking)', recorded: false, url: 'about:blank' }),
    ],
    hostPid: async () => 99,
    display: async () => 'hidden' as const,
    measure: () => ({ renderers: 7, bytes: 3 * 2 ** 30 }),
    ageOf: () => 2 * 3_600_000,
    desk: async () => ({ info: { pid: 99, host: '100.1.2.3', port: 4000, token: 'tok' }, items: [{ id: 'd1', label: 'AWS', kind: 'captcha' as const, targetId: 'BBBB2222', createdAt: NOW - 300_000, status: 'waiting' as const }] }),
    chats: async () => new Map([[41, '9d0c4a35-1abf']]),
    alive: (pid: number) => pid === 41,
    notices: async () => [],
    watchViews: async () => new Map([['CCCC3333', 'http://127.0.0.1:6000/w/']]),
  };

  it('joins the records, the browser\'s pages and the desk, with totals', async () => {
    const overview = await browsersOverview('/nowhere', deps);
    expect(overview.totals).toEqual({ tabs: 3, waiting: 1, longestWaitMs: 300_000, unrecorded: 1 });
    expect(overview).toMatchObject({ running: true, display: 'hidden', hostPid: 99, renderers: 7, ageMs: 7_200_000, desk: 'http://100.1.2.3:4000/tok/' });
    expect(overview.tabs[0]!.url).toBe('https://signin.aws.amazon.com/oauth?…');
    expect(JSON.stringify(overview)).not.toContain('SECRET');
    expect(overview.tabs[0]).toMatchObject({ n: 1, name: 'signup', chat: '9d0c4a35-1abf', ownerAlive: true, liveView: 'http://127.0.0.1:5000/t/', idleMs: 30_000 });
    expect(overview.tabs[1]).toMatchObject({ parked: true, egress: 'prod', waiting: { label: 'AWS', kind: 'captcha', waitedMs: 300_000, address: 'http://100.1.2.3:4000/tok/t/d1/' } });
    const text = browsersText(overview, 'how');
    expect(text).toContain('3 tabs open, 1 waiting on you (longest 5m), 1 unrecorded · window hidden (virtual display), up 2h, 7 renderers, 3.0 GB');
    expect(text).toContain('"signup" · chat 9d0c4a35');
    expect(text).toContain('WAITING ON YOU 5m: AWS [captcha]');
    expect(text).toContain('unrecorded');
    expect(text.trim().endsWith('how')).toBe(true);
  });

  it('shows a watch view as open, like a show view', async () => {
    const overview = await browsersOverview('/nowhere', deps);
    expect(overview.tabs[2]!.liveView).toBe('http://127.0.0.1:6000/w/');
    expect(browsersText(overview, 'how')).toContain('live view open http://127.0.0.1:6000/w/');
  });

  it('lists open notices under their own heading, with or without a browser', async () => {
    const notice = { key: 'clikdeploy-unlock', title: 'Writes held', message: 'Renew the unlock.', createdAt: NOW - 120_000, updatedAt: NOW, count: 3 };
    const overview = await browsersOverview('/nowhere', { ...deps, notices: async () => [notice] });
    expect(overview.notices).toEqual([notice]);
    const text = browsersText(overview, 'how', { now: NOW, dismiss: 'Dismiss one: /browsers dismiss <key>' });
    expect(text).toContain('Notices (1):\n  Writes held: Renew the unlock. (2 min, said 3 times; key clikdeploy-unlock)\n  Dismiss one: /browsers dismiss <key>');
    const stopped = await browsersOverview('/nowhere', { ...deps, tabs: async () => undefined, notices: async () => [notice] });
    expect(browsersText(stopped, 'how', { now: NOW })).toMatch(/^Notices \(1\):[\s\S]*not running/);
  });

  it('names a tab by number, name or id', async () => {
    const overview = await browsersOverview('/nowhere', deps);
    expect(pickTab(overview, '2').id).toBe('BBBB2222');
    expect(pickTab(overview, 'signup').id).toBe('AAAA1111');
    expect(pickTab(overview, 'cccc').id).toBe('CCCC3333');
    expect(() => pickTab(overview, '9')).toThrow(/No open tab/);
  });

  it('says so when no browser runs', async () => {
    const overview = await browsersOverview('/nowhere', { ...deps, tabs: async () => undefined, hostPid: async () => undefined });
    expect(overview.running).toBe(false);
    expect(browsersText(overview, 'how')).toMatch(/not running/);
  });

  it('keeps a watch view while its process runs, and drops one whose process ended', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'watch-'));
    try {
      await recordWatchView(dir, 'TAB1', 'http://127.0.0.1:7000/x/');
      expect(await watchViews(dir, () => true)).toEqual(new Map([['TAB1', 'http://127.0.0.1:7000/x/']]));
      expect(await watchViews(dir, () => false)).toEqual(new Map());
      expect(await watchViews(dir, () => true)).toEqual(new Map());
      await recordWatchView(dir, 'TAB2', 'http://127.0.0.1:7001/y/');
      await forgetWatchView(dir, 'TAB2');
      expect(await watchViews(dir)).toEqual(new Map());
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reads a process age from /proc', () => {
    const files: Record<string, string> = { '/proc/5/stat': `5 (chrome (x)) S ${'0 '.repeat(18)}10000 rest`, '/proc/uptime': '200.00 1.0' };
    expect(processAgeMs(5, file => files[file]!)).toBe(100_000);
  });
});
