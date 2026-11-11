import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { claimMessage, isClaimed } from './email-consumed.js';

let dir: string | undefined;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

it('one of several waiters takes a message, and a lock left by a process that died does not hold them up', async () => {
  dir = await mkdtemp(join(tmpdir(), 'cc-email-consumed-'));
  await mkdir(join(dir, 'computer'), { recursive: true });
  // A fresh lock whose holder is gone: the old lock waited out its age (10 s) before breaking it.
  await writeFile(join(dir, 'computer', 'email-consumed.json.lock'), JSON.stringify({ pid: 2 ** 22 + 1, host: hostname(), nonce: 'x', at: new Date().toISOString() }));
  const began = Date.now();
  const taken = await Promise.all(Array.from({ length: 5 }, () => claimMessage(dir!, 'msg-1')));
  expect(taken.filter(Boolean)).toHaveLength(1);
  expect(await isClaimed(dir, 'msg-1')).toBe(true);
  expect(Date.now() - began).toBeLessThan(5_000);
});
