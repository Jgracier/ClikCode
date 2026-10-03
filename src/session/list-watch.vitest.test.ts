import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchConversationList, type ListWatch } from './list-watch';

let root: string | undefined;
let watcher: ListWatch | undefined;
afterEach(async () => {
  watcher?.stop();
  watcher = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

/** Resolves on the next change report, or rejects after `ms`. */
function nextChange(counter: { count: number }, ms = 3_000): Promise<void> {
  const start = counter.count;
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const check = (): void => {
      if (counter.count > start) resolve();
      else if (Date.now() > deadline) reject(new Error('no change reported'));
      else setTimeout(check, 20);
    };
    check();
  });
}

describe('watchConversationList', () => {
  it('reports a session file, a worker record and the index changing, coalesced', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-list-watch-'));
    const sessions = join(root, 'sessions');
    const workers = join(root, 'workers');
    await mkdir(sessions);
    const counter = { count: 0 };
    watcher = watchConversationList(() => { counter.count += 1; }, { directories: [root, sessions, workers], debounceMs: 20, minIntervalMs: 50 });
    expect(watcher.watching).toBe(true);

    let change = nextChange(counter);
    await writeFile(join(sessions, 'a.json'), '{}');
    await change;

    // A burst (a streaming turn's checkpoints) is one report, not one each.
    change = nextChange(counter);
    const before = counter.count;
    for (let index = 0; index < 10; index += 1) await writeFile(join(sessions, 'a.json'), `{"n":${index}}`);
    await change;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(counter.count - before).toBeLessThanOrEqual(3);

    // The workers directory did not exist; it is picked up when it appears.
    change = nextChange(counter);
    await mkdir(workers);
    await change;
    await new Promise((resolve) => setTimeout(resolve, 100));
    change = nextChange(counter);
    await writeFile(join(workers, 'w.json'), '{}');
    await change;

    change = nextChange(counter);
    await writeFile(join(root, 'index.json'), '{}');
    await change;
  });

  it('ignores unrelated files beside the index', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-list-watch-'));
    const counter = { count: 0 };
    watcher = watchConversationList(() => { counter.count += 1; }, { directories: [root, join(root, 'sessions')], debounceMs: 10, minIntervalMs: 10 });
    await writeFile(join(root, 'debug.log'), 'x');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(counter.count).toBe(0);
  });

  it('falls back to a slow poll when the state directory cannot be watched', async () => {
    const counter = { count: 0 };
    watcher = watchConversationList(() => { counter.count += 1; }, { directories: [join(tmpdir(), 'clikcode-missing-dir-for-watch-test')], fallbackMs: 30 });
    expect(watcher.watching).toBe(false);
    await nextChange(counter, 1_000);
    watcher.stop();
    const stopped = counter.count;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(counter.count).toBe(stopped);
  });
});
