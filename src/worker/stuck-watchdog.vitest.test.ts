import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WATCHDOG_THREAD } from './stuck-watchdog.js';

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A real process running the real thread: its event loop either blocks or keeps beating. */
function run(body: string): { signal: NodeJS.Signals | null; status: number | null; log: string } {
  dir = mkdtempSync(join(tmpdir(), 'clikcode-watchdog-'));
  const log = join(dir, 'lifecycle.log');
  const script = `
    const { Worker } = require('node:worker_threads');
    const beats = new Int32Array(new SharedArrayBuffer(4));
    const thread = new Worker(${JSON.stringify(WATCHDOG_THREAD)}, { eval: true,
      workerData: { beats: beats.buffer, stuckMs: 300, checkMs: 50, log: ${JSON.stringify(log)}, sessionId: 's1' } });
    thread.unref();
    ${body}`;
  const result = spawnSync(process.execPath, ['-e', script], { timeout: 15_000 });
  let text = '';
  try { text = readFileSync(log, 'utf8'); } catch { /* none written */ }
  return { signal: result.signal, status: result.status, log: text };
}

describe('stuck worker watchdog', () => {
  it('kills a process whose event loop stopped turning, and says so', () => {
    const result = run(`setTimeout(() => { const end = Date.now() + 10000; while (Date.now() < end) {} }, 100);`);
    expect(result.signal).toBe('SIGKILL');
    expect(JSON.parse(result.log.trim())).toMatchObject({ event: 'worker.stuck', session: 's1', role: 'worker' });
  });

  it('leaves one whose event loop keeps turning', () => {
    const result = run(`const beat = setInterval(() => Atomics.add(beats, 0, 1), 50); setTimeout(() => { clearInterval(beat); process.exit(0); }, 1500);`);
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.log).toBe('');
  });
});
