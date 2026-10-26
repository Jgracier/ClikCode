import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { diagnostic, lifecycleLogPath, observeChildProcesses, quiet, swallowed } from './lifecycle-log.js';

describe('errors that are swallowed on purpose', () => {
  let home: string;
  const saved = { home: process.env.CLIKCODE_HOME, enabled: process.env.CLIKCODE_LIFECYCLE_LOG };
  const records = (): Array<Record<string, unknown>> => {
    try { return readFileSync(lifecycleLogPath(), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>); } catch { return []; }
  };
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clikcode-swallowed-'));
    process.env.CLIKCODE_HOME = home;
    process.env.CLIKCODE_LIFECYCLE_LOG = '1';
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const [key, value] of [['CLIKCODE_HOME', saved.home], ['CLIKCODE_LIFECYCLE_LOG', saved.enabled]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('writes the first one, then one a minute with how many more there were', () => {
    vi.setSystemTime(new Date('2026-10-26T10:00:00Z'));
    for (let index = 0; index < 5; index += 1) swallowed('worker/state-sweep', new Error(`disk is full (${index})`));
    vi.setSystemTime(new Date('2026-10-26T10:01:30Z'));
    swallowed('worker/state-sweep', Object.assign(new Error('disk is full again'), { code: 'ENOSPC' }));
    expect(records().map((record) => [record.event, record.area, record.errno, record.more])).toEqual([
      ['swallowed', 'worker/state-sweep', undefined, undefined],
      ['swallowed', 'worker/state-sweep', 'ENOSPC', 4],
    ]);
  });

  it('keeps one area from hiding another, and leaves out what is never news', () => {
    swallowed('a', new Error('x'));
    swallowed('b', new Error('y'));
    swallowed('c', Object.assign(new Error('gone'), { code: 'ENOENT' }));
    swallowed('d', Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    expect(records().map((record) => record.area)).toEqual(['a', 'b']);
  });

  it('is a promise handler that returns nothing, and masks a credential in the message', async () => {
    const value = await Promise.reject(new Error('failed: Authorization: Bearer abcdef0123456789abcdef')).catch(quiet('turn/x'));
    expect(value).toBeUndefined();
    const [record] = records();
    expect(record?.message).not.toContain('abcdef0123456789');
    diagnostic('thing', 'token=hunter2hunter2 was rejected');
    expect(JSON.stringify(records().at(-1))).not.toContain('hunter2hunter2');
  });

  it('writes down a child process that fails, by program and argument count, never what the arguments were', async () => {
    vi.useRealTimers();
    observeChildProcesses();
    const failing = spawn(process.execPath, ['-e', 'process.exit(3)', 'a-private-argument']);
    await new Promise((resolve) => failing.once('exit', resolve));
    const missing = spawn('definitely-not-a-program', ['x']);
    await new Promise((resolve) => missing.once('error', resolve));
    const ok = spawn(process.execPath, ['-e', '0']);
    await new Promise((resolve) => ok.once('exit', resolve));
    const failed = records().filter((record) => record.event === 'child.failed');
    expect(failed.map((record) => [record.program, record.code ?? record.errno])).toEqual([['node', 3], ['definitely-not-a-program', 'ENOENT']]);
    expect(failed[0]).toMatchObject({ argc: 3 });
    expect(JSON.stringify(failed)).not.toContain('a-private-argument');
  });
});
