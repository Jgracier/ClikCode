import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withFileLock } from './locks.js';

const previousHome = process.env.CLIKCODE_HOME;
let root: string | undefined;

afterEach(async () => {
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe('withFileLock reentrancy', () => {
  it('lets a nested call on the same path, in the same chain, run without re-waiting', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-locks-'));
    const path = join(root, 'a.lock');
    const order: string[] = [];
    await withFileLock(path, async () => {
      order.push('outer-start');
      await withFileLock(path, async () => { order.push('inner'); });
      order.push('outer-end');
    });
    expect(order).toEqual(['outer-start', 'inner', 'outer-end']);
  });

  it('still serializes two different call chains on the same path, even though each is itself reentrant', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-locks-'));
    const path = join(root, 'b.lock');
    const order: string[] = [];
    const chain = (name: string, holdMs: number) => withFileLock(path, async () => {
      order.push(`${name}-start`);
      // A nested call inside each chain must not let the two chains interleave.
      await withFileLock(path, async () => new Promise((resolve) => setTimeout(resolve, holdMs)));
      order.push(`${name}-end`);
    });
    await Promise.all([chain('a', 20), chain('b', 0)]);
    // Whichever chain acquires first must fully finish (both its start and its
    // end) before the other chain starts -- no interleaving across chains.
    expect(order[0]!.endsWith('-start')).toBe(true);
    expect(order[1]).toBe(`${order[0]!.replace('-start', '')}-end`);
    expect(order[2]!.endsWith('-start')).toBe(true);
    expect(order[3]).toBe(`${order[2]!.replace('-start', '')}-end`);
  });

  it('does not treat a different path as reentrant, and does not leave the first lock file behind', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-locks-'));
    const pathA = join(root, 'c.lock');
    const pathB = join(root, 'd.lock');
    const order: string[] = [];
    await withFileLock(pathA, async () => {
      order.push('a');
      await withFileLock(pathB, async () => { order.push('b'); });
    });
    expect(order).toEqual(['a', 'b']);
    await expect(readFile(pathA, 'utf8')).rejects.toThrow();
    await expect(readFile(pathB, 'utf8')).rejects.toThrow();
  });

  it('propagates a nested error without leaving the outer lock file behind', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-locks-'));
    const path = join(root, 'e.lock');
    await expect(withFileLock(path, async () => {
      await withFileLock(path, async () => { throw new Error('boom'); });
    })).rejects.toThrow('boom');
    await expect(readFile(path, 'utf8')).rejects.toThrow();
  });
});
