/** A model's download runs on its own: one per model in this process, reported to whoever listens, and serialized across processes. */
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowBackgroundDownloads, backgroundDownloadsAllowed, modelDownloads, onDownloadOutcome, onModelDownload, reportDownloadOutcome, startModelDownload } from './downloads.js';
import { withDownloadLock, serverDir } from './lifecycle.js';
import type { LocalModelProgress } from './index.js';

let home: string;
const saved = process.env.CLIKCODE_LOCAL_MODELS_HOME;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cc-downloads-')); process.env.CLIKCODE_LOCAL_MODELS_HOME = home; });
afterEach(() => {
  if (saved === undefined) delete process.env.CLIKCODE_LOCAL_MODELS_HOME; else process.env.CLIKCODE_LOCAL_MODELS_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

/** A fetch the test finishes by hand. */
function controlled() {
  let finish!: () => void; let fail!: (error: Error) => void; let calls = 0; let signal: AbortSignal | undefined;
  let report!: (update: LocalModelProgress) => void;
  const fetch = (_model: string, progress: (update: LocalModelProgress) => void, abort?: AbortSignal): Promise<void> => {
    calls += 1; signal = abort; report = progress;
    return new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; abort?.addEventListener('abort', () => reject(new Error('The download was cancelled.'))); });
  };
  return { fetch, finish: () => finish(), fail: (message: string) => fail(new Error(message)), get calls() { return calls; }, get signal() { return signal; }, report: (update: LocalModelProgress) => report(update) };
}
const tick = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('a model download', () => {
  it('is one per model: asked again, it is the fetch already running', async () => {
    const fake = controlled();
    const first = startModelDownload('qwen3.5-4b', fake.fetch);
    const second = startModelDownload('qwen3.5-4b', fake.fetch);
    expect(second).toBe(first);
    await tick();
    expect(fake.calls).toBe(1);
    expect(modelDownloads().map((job) => job.modelId)).toEqual(['qwen3.5-4b']);
    fake.finish();
    await first.done;
    expect(modelDownloads()).toEqual([]);
  });

  it('does not wait for anything: starting it returns at once, whatever the fetch takes', () => {
    const fake = controlled();
    const started = Date.now();
    const job = startModelDownload('qwen3.5-9b', fake.fetch);
    expect(Date.now() - started).toBeLessThan(50);
    job.cancel();
    return job.done.catch(() => undefined);
  });

  it('tells every listener each report, then that it ended, and what it reported is gone with it', async () => {
    const fake = controlled();
    const seen: Array<string | undefined> = [];
    const stop = onModelDownload((job) => seen.push(job.progress ? `${job.progress.message}@${job.progress.bytes}` : 'ended'));
    const job = startModelDownload('gemma-4-12b', fake.fetch);
    await tick();
    fake.report({ stage: 'download', message: 'downloading gemma', bytes: 10, totalBytes: 100 });
    fake.report({ stage: 'download', message: 'downloading gemma', bytes: 50, totalBytes: 100 });
    fake.finish();
    await job.done;
    stop();
    expect(seen).toEqual(['downloading gemma@10', 'downloading gemma@50', 'ended']);
  });

  it('rejects for whoever awaits it when the fetch fails, and is not a job any more', async () => {
    const fake = controlled();
    const job = startModelDownload('gpt-oss-20b', fake.fetch);
    await tick();
    fake.fail('Download failed (HTTP 503)');
    await expect(job.done).rejects.toThrow('HTTP 503');
    expect(modelDownloads()).toEqual([]);
    // Asked again, it starts a new one.
    const again = controlled();
    const next = startModelDownload('gpt-oss-20b', again.fetch);
    expect(next).not.toBe(job);
    next.cancel();
    await next.done.catch(() => undefined);
  });

  it('is stopped by cancel, through the signal the fetch was given', async () => {
    const fake = controlled();
    const job = startModelDownload('qwen3.5-4b', fake.fetch);
    await tick();
    job.cancel();
    expect(fake.signal?.aborted).toBe(true);
    await expect(job.done).rejects.toThrow(/cancelled/);
  });
});

describe('background downloads', () => {
  it('are allowed only while a host that outlives the command says so, and by every host that did', () => {
    expect(backgroundDownloadsAllowed()).toBe(false);
    const window = allowBackgroundDownloads();
    const editor = allowBackgroundDownloads();
    expect(backgroundDownloadsAllowed()).toBe(true);
    window();
    window(); // withdrawn twice: counted once
    expect(backgroundDownloadsAllowed()).toBe(true);
    editor();
    expect(backgroundDownloadsAllowed()).toBe(false);
  });

  it('say how one ended to whoever listens, and stop when they stop', () => {
    const seen: string[] = [];
    const stop = onDownloadOutcome((outcome) => seen.push(`${outcome.sessionId}:${outcome.switched}:${outcome.text}`));
    reportDownloadOutcome({ sessionId: 's1', modelId: 'm', switched: true, level: 'info', text: 'ready' });
    stop();
    reportDownloadOutcome({ sessionId: 's2', modelId: 'm', switched: false, level: 'error', text: 'failed' });
    expect(seen).toEqual(['s1:true:ready']);
  });
});

describe('the download lock', () => {
  it('runs two downloads of one model one after the other, never together', async () => {
    const order: string[] = [];
    let release!: () => void;
    // `a` holds the lock until it is let go, so which of two started together wins it is not what the test depends on.
    const a = withDownloadLock('qwen3.5-4b', async () => { order.push('a start'); await new Promise<void>((resolve) => { release = resolve; }); order.push('a end'); });
    const deadline = Date.now() + 5_000;
    while (!order.includes('a start') && Date.now() < deadline) await tick(5);
    const b = withDownloadLock('qwen3.5-4b', async () => { order.push('b start'); order.push('b end'); });
    // Longer than the lock's poll (500 ms): `b` has had two chances to take it, and must not have.
    await tick(1_200);
    expect(order).toEqual(['a start']);
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(['a start', 'a end', 'b start', 'b end']);
  });

  it('is not broken by age -- a download takes as long as the link does -- but is by a holder that is gone', async () => {
    mkdirSync(serverDir('gemma-4-12b'), { recursive: true });
    const lock = join(serverDir('gemma-4-12b'), 'download.lock');
    // Held by a process that is alive, and old: still held.
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() - 6 * 3_600_000 }));
    const controller = new AbortController();
    const waiting = withDownloadLock('gemma-4-12b', async () => 'ran', controller.signal);
    await tick(700);
    controller.abort();
    await expect(waiting).rejects.toThrow(/cancelled/);
    expect(existsSync(lock)).toBe(true);
    // Held by one that is gone: taken over.
    writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 - 1, at: Date.now() }));
    await expect(withDownloadLock('gemma-4-12b', async () => 'ran')).resolves.toBe('ran');
    expect(existsSync(lock)).toBe(false);
  });

  it('remembers which chats asked for it, once each, and tells the listeners when another asks', async () => {
    const fake = controlled();
    const job = startModelDownload('qwen3.5-4b', fake.fetch);
    expect([...job.askers]).toEqual([]);
    const seen: number[] = [];
    const stop = onModelDownload((download) => seen.push(download.askers.size));
    job.ask('s1');
    job.ask('s1');
    // The same job for the same model, so a second chat asking is the same download shown in that chat too.
    startModelDownload('qwen3.5-4b', fake.fetch).ask('s2');
    expect([...job.askers]).toEqual(['s1', 's2']);
    expect(seen).toEqual([1, 2]);
    stop();
    await tick();
    fake.finish();
    await job.done;
  });
});
