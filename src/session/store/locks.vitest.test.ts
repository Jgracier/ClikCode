import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withFileLock } from './locks.js';

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

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
});
