import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { addDeskItem, deskHeldTargets, deskToken, DESK_WAIT_MS, finishDeskItem, listDeskItems, readDeskInfo, takeFinishedResumes, tidyDesk, writeDeskInfo } from './handoff-desk-store.js';
import { deskListing, deskListPage } from './handoff-desk.js';
import { planTabClosures, type TabRecord } from './tab-registry.js';

let dir = '';
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'desk-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

it('keeps one address: the token is made once and read back', async () => {
  const first = await deskToken(dir);
  expect(first).toMatch(/^[A-Za-z0-9_-]{24,}$/);
  expect(await deskToken(dir)).toBe(first);
});

it('says where the desk is only while its host process is alive', async () => {
  await writeDeskInfo(dir, { pid: 4242, host: '100.70.1.2', port: 47811, token: 'x'.repeat(32) });
  expect(await readDeskInfo(dir, () => true)).toMatchObject({ port: 47811 });
  expect(await readDeskInfo(dir, () => false)).toBeUndefined();
});

it('gives a tab one waiting item, however often it is asked for', async () => {
  const a = await addDeskItem(dir, { targetId: 'T1', label: 'acme', kind: 'captcha', url: 'https://app.acme.test/signup?x=secret' }, 1_000);
  const again = await addDeskItem(dir, { targetId: 'T1', label: 'acme again' }, 2_000);
  expect(again.id).toBe(a.id);
  expect(a.host).toBe('app.acme.test');
  expect(JSON.stringify(a)).not.toContain('secret');
  expect((await listDeskItems(dir)).length).toBe(1);
});

it('holds the tab while its item waits, and lets go once it is done or too old', async () => {
  const item = await addDeskItem(dir, { targetId: 'T1', label: 'acme' }, 1_000);
  expect([...await deskHeldTargets(dir, 2_000)]).toEqual(['T1']);
  expect((await deskHeldTargets(dir, 1_000 + DESK_WAIT_MS)).size).toBe(0);
  await finishDeskItem(dir, item.id, 'done', 3_000);
  expect((await deskHeldTargets(dir, 4_000)).size).toBe(0);
});

it('never closes a desk-held tab: not for a dead owner, idleness or the tab cap', () => {
  const record = (id: string, lastUsedAt: number, ownerPid: number): TabRecord => ({ id, ownerPid, owner: 'w', openedAt: 0, lastUsedAt });
  const now = 10 * 3_600_000;
  const records = [record('held', 0, 99), record('dead', now, 99), record('idle', 0, 1), record('a', now - 60_000, 1), record('b', now - 50_000, 1)];
  const plan = planTabClosures({ records, liveIds: new Set(records.map(r => r.id)), now, limits: { idleMs: 20 * 60_000, maxTabs: 1 }, alive: pid => pid === 1, deskHeld: new Set(['held']) });
  const closed = plan.close.map(c => c.id);
  expect(closed).not.toContain('held');
  expect(closed).toEqual(expect.arrayContaining(['dead', 'idle']));
});

it('hands each finished vendor back to the loop once', async () => {
  const a = await addDeskItem(dir, { targetId: 'T1', label: 'acme', resume: 'acme' });
  await addDeskItem(dir, { targetId: 'T2', label: 'chat step' });
  expect(await takeFinishedResumes(dir)).toEqual([]);
  await finishDeskItem(dir, a.id, 'done');
  expect((await takeFinishedResumes(dir)).map(item => item.resume)).toEqual(['acme']);
  expect(await takeFinishedResumes(dir)).toEqual([]);
});

it('closes an item whose tab is gone, and forgets old finished ones', async () => {
  const gone = await addDeskItem(dir, { targetId: 'GONE', label: 'x' }, 1_000);
  const here = await addDeskItem(dir, { targetId: 'HERE', label: 'y' }, 1_000);
  await tidyDesk(dir, new Set(['HERE']), 2_000);
  const after = await listDeskItems(dir);
  expect(after.find(item => item.id === gone.id)?.status).toBe('closed');
  expect(after.find(item => item.id === here.id)?.status).toBe('waiting');
  // A day on: the one that waited too long is closed, the old closed one forgotten; another day on, nothing is left.
  await tidyDesk(dir, new Set(['HERE']), 2_000 + 25 * 3_600_000);
  expect((await listDeskItems(dir)).map(item => [item.id, item.status])).toEqual([[here.id, 'closed']]);
  await tidyDesk(dir, new Set(['HERE']), 2_000 + 50 * 3_600_000);
  expect(await listDeskItems(dir)).toEqual([]);
});

it('lists only what waits, without tab ids or full addresses', async () => {
  const a = await addDeskItem(dir, { targetId: 'T1', label: 'acme', kind: 'captcha', note: 'press the box', url: 'https://acme.test/a/b?k=v' }, 0);
  const b = await addDeskItem(dir, { targetId: 'T2', label: 'done one' }, 0);
  await finishDeskItem(dir, b.id, 'done', 1);
  const listing = deskListing(await listDeskItems(dir), 5 * 60_000);
  expect(listing).toEqual([{ id: a.id, label: 'acme', kind: 'Human check', note: 'press the box', host: 'acme.test', minutes: 5 }]);
  expect(JSON.stringify(listing)).not.toContain('T1');
  expect(deskListPage()).toContain('Waiting on you');
});
