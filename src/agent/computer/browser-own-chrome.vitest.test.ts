import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { chromeIsHostChild, parentPid } from './browser.js';

const dirs: string[] = [];
const kids: Array<() => void> = [];
afterEach(async () => { kids.splice(0).forEach(k => k()); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

async function state(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'clikcode-own-chrome-'));
  dirs.push(dir);
  await mkdir(join(dir, 'computer'), { recursive: true });
  return dir;
}

it('reads a process parent from /proc', async () => {
  expect(await parentPid(process.pid)).toBe(process.ppid);
  expect(await parentPid(2 ** 30)).toBe(0);
});

it('calls a Chrome that is a child of the recorded live host ours, and a stranger not', async () => {
  const dir = await state();
  // This process stands in for the host; a child it spawns stands in for Chrome.
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  kids.push(() => child.kill());
  await writeFile(join(dir, 'computer', 'host.json'), JSON.stringify({ pid: process.pid }));
  expect(await chromeIsHostChild(dir, child.pid!)).toBe(true);
  // A process that is not the host's child is foreign.
  expect(await chromeIsHostChild(dir, process.ppid)).toBe(false);
});

it('treats a missing or dead host record as foreign', async () => {
  const dir = await state();
  expect(await chromeIsHostChild(dir, process.pid)).toBe(false);
  await writeFile(join(dir, 'computer', 'host.json'), JSON.stringify({ pid: 2 ** 30 }));
  expect(await chromeIsHostChild(dir, process.pid)).toBe(false);
  await symlink('x', join(dir, 'unused')).catch(() => undefined);
});
