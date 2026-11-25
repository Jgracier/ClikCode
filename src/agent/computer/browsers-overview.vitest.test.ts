import { describe, expect, it } from 'vitest';
import { browsersOverview, browsersText, pickTab, processAgeMs } from './browsers-overview.js';
import type { TabView } from './tab-registry.js';

const NOW = 10_000_000;
const view = (change: Partial<TabView>): TabView => ({ id: 'AAAA1111', ownerPid: 0, owner: 'worker 1', openedAt: NOW - 600_000, lastUsedAt: NOW - 30_000, url: 'https://example.com/', recorded: true, ...change });

describe('the browsers list', () => {
  const deps = {
    now: NOW,
    tabs: async () => [
      view({ id: 'AAAA1111', tab: 'signup', ownerPid: 41, owner: 'worker 41 (session 9d0c4a35)', url: 'https://signin.aws.amazon.com/', title: 'Sign in', liveView: 'http://127.0.0.1:5000/t/' }),
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
  };

  it('joins the records, the browser\'s pages and the desk, with totals', async () => {
    const overview = await browsersOverview('/nowhere', deps);
    expect(overview.totals).toEqual({ tabs: 3, waiting: 1, longestWaitMs: 300_000, unrecorded: 1 });
    expect(overview).toMatchObject({ running: true, display: 'hidden', hostPid: 99, renderers: 7, ageMs: 7_200_000, desk: 'http://100.1.2.3:4000/tok/' });
    expect(overview.tabs[0]).toMatchObject({ n: 1, name: 'signup', chat: '9d0c4a35-1abf', ownerAlive: true, liveView: 'http://127.0.0.1:5000/t/', idleMs: 30_000 });
    expect(overview.tabs[1]).toMatchObject({ parked: true, egress: 'prod', waiting: { label: 'AWS', kind: 'captcha', waitedMs: 300_000, address: 'http://100.1.2.3:4000/tok/t/d1/' } });
    const text = browsersText(overview, 'how');
    expect(text).toContain('3 tabs open, 1 waiting on you (longest 5m), 1 unrecorded · window hidden (virtual display), up 2h, 7 renderers, 3.0 GB');
    expect(text).toContain('"signup" · chat 9d0c4a35');
    expect(text).toContain('WAITING ON YOU 5m: AWS [captcha]');
    expect(text).toContain('unrecorded');
    expect(text.trim().endsWith('how')).toBe(true);
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

  it('reads a process age from /proc', () => {
    const files: Record<string, string> = { '/proc/5/stat': `5 (chrome (x)) S ${'0 '.repeat(18)}10000 rest`, '/proc/uptime': '200.00 1.0' };
    expect(processAgeMs(5, file => files[file]!)).toBe(100_000);
  });
});
