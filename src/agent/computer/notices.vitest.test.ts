import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearNotice, desktopNotify, listNotices, NOTICE_MESSAGE_MAX, noticesLine, postNotice } from './notices.js';

let dir = '';
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'notices-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const input = { key: 'clikdeploy-unlock', title: 'Writes held', message: 'Renew the unlock.' };

it('the first post raises one desktop popup; the same key again only updates the entry', async () => {
  const desktop = vi.fn(async () => true);
  expect((await postNotice(dir, input, { desktop, now: 1_000 })).delivered).toBe('desktop');
  const again = await postNotice(dir, { ...input, message: 'Still held.' }, { desktop, now: 5_000 });
  expect(again).toMatchObject({ delivered: 'deduped', key: 'clikdeploy-unlock' });
  expect(desktop).toHaveBeenCalledTimes(1);
  const [notice] = await listNotices(dir);
  expect(notice).toMatchObject({ message: 'Still held.', createdAt: 1_000, updatedAt: 5_000, count: 2, desktopAt: 1_000 });
});

it('two callers racing on one key raise one popup', async () => {
  const desktop = vi.fn(async () => true);
  const results = await Promise.all([postNotice(dir, input, { desktop }), postNotice(dir, input, { desktop })]);
  expect(results.map(result => result.delivered).sort()).toEqual(['deduped', 'desktop']);
  expect(desktop).toHaveBeenCalledTimes(1);
});

it('clear removes it, and the next post of that key is new again', async () => {
  const desktop = vi.fn(async () => true);
  await postNotice(dir, input, { desktop });
  expect(await clearNotice(dir, input.key)).toBe(true);
  expect(await listNotices(dir)).toEqual([]);
  expect(await clearNotice(dir, input.key)).toBe(false);
  expect((await postNotice(dir, input, { desktop })).delivered).toBe('desktop');
  expect(desktop).toHaveBeenCalledTimes(2);
});

it('with no desktop the notice is on the desk only', async () => {
  const result = await postNotice(dir, input, { desktop: async () => false });
  expect(result.delivered).toBe('desk');
  expect((await listNotices(dir))[0]).not.toHaveProperty('desktopAt');
  // The real notifier finds no desktop on a Linux server with no display and no Wayland socket, and runs nothing.
  const run = vi.fn();
  expect(await desktopNotify('t', 'b', { env: { XDG_RUNTIME_DIR: path.join(dir, 'none') }, platform: 'linux', run: run as never })).toBe(false);
  expect(await desktopNotify('t', 'b', { env: { DISPLAY: ':0', SSH_CONNECTION: '1 2 3 4' }, platform: 'linux', run: run as never })).toBe(false);
  expect(run).not.toHaveBeenCalled();
});

it('runs notify-send on a desktop, and a failing notifier means desk', async () => {
  const run = vi.fn((_c: string, _a: string[], _o: unknown, done: (error: Error | null) => void) => done(null));
  expect(await desktopNotify('Title', 'Body', { env: { DISPLAY: ':0' }, platform: 'linux', run: run as never })).toBe(true);
  expect(run.mock.calls[0]![0]).toBe('notify-send');
  expect(run.mock.calls[0]![1]).toEqual(['--app-name=ClikCode', '--urgency=normal', '--', 'Title', 'Body']);
  const fails = vi.fn((_c: string, _a: string[], _o: unknown, done: (error: Error | null) => void) => done(new Error('ENOENT')));
  expect(await desktopNotify('Title', 'Body', { env: { DISPLAY: ':0' }, platform: 'linux', run: fails as never })).toBe(false);
});

it('keeps the message plain and short, and refuses a bad key or address', async () => {
  const { notice } = await postNotice(dir, { ...input, message: `line one\nline\u0007two ${'x'.repeat(400)}` }, { desktop: async () => false });
  expect(notice.message.startsWith('line one line two')).toBe(true);
  expect([...notice.message].length).toBeLessThanOrEqual(NOTICE_MESSAGE_MAX);
  await expect(postNotice(dir, { ...input, key: '../etc' }, { desktop: async () => false })).rejects.toThrow('--key');
  await expect(postNotice(dir, { ...input, url: 'javascript:alert(1)' }, { desktop: async () => false })).rejects.toThrow('http');
  await expect(postNotice(dir, { ...input, message: '  ' }, { desktop: async () => false })).rejects.toThrow('message');
});

it('names the newest notice in one line', async () => {
  await postNotice(dir, input, { desktop: async () => false, now: 1 });
  await postNotice(dir, { ...input, key: 'other', title: 'Other' }, { desktop: async () => false, now: 2 });
  expect(noticesLine(await listNotices(dir))).toMatch(/^Notice: Other: Renew the unlock\. \(\+1 more\)/);
  expect(noticesLine([])).toBeUndefined();
});
