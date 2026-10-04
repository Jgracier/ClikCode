import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lifecycle, lifecycleLogPath, setLifecycleRole, setLifecycleSession } from './lifecycle-log.js';
import { formatEntry, matches, sinceCutoff } from '../commands/logs.js';

describe('the lifecycle log', () => {
  let home: string;
  const saved = { home: process.env.CLIKCODE_HOME, enabled: process.env.CLIKCODE_LIFECYCLE_LOG };
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clikcode-lifecycle-'));
    process.env.CLIKCODE_HOME = home;
    process.env.CLIKCODE_LIFECYCLE_LOG = '1';
  });
  afterEach(() => {
    for (const [key, value] of [['CLIKCODE_HOME', saved.home], ['CLIKCODE_LIFECYCLE_LOG', saved.enabled]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('writes one JSON record per moment, with who wrote it and for which conversation', () => {
    setLifecycleRole('worker', 'conv-1');
    lifecycle('worker.turn.end', { outcome: 'completed', ms: 42 });
    setLifecycleSession('conv-2');
    lifecycle('worker.idle', { state: 'idle: exits in 1800s' });
    const records = readFileSync(lifecycleLogPath(), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toEqual([
      expect.objectContaining({ pid: process.pid, role: 'worker', session: 'conv-1', event: 'worker.turn.end', outcome: 'completed', ms: 42 }),
      expect.objectContaining({ session: 'conv-2', event: 'worker.idle', state: 'idle: exits in 1800s' }),
    ]);
  });

  it('never lets a fact pass for the writer\'s own pid or role', () => {
    setLifecycleRole('worker', 'conv-1');
    lifecycle('vendor.child.spawn', { pid: 1, role: 'window', child: 99 });
    const record = JSON.parse(readFileSync(lifecycleLogPath(), 'utf8').trim()) as Record<string, unknown>;
    expect(record).toMatchObject({ pid: process.pid, role: 'worker', child: 99 });
  });

  it('never brings back a home that was deleted', () => {
    rmSync(home, { recursive: true, force: true });
    lifecycle('worker.idle', { state: 'x' });
    expect(existsSync(home)).toBe(false);
  });

  it('reads back as lines, filtered by conversation, role and age', () => {
    const entry = { t: '2026-10-04T18:01:02.345Z', pid: 77, role: 'window', session: 'e5bb5bec-3156', event: 'window.turn.start', label: 'thinking', steerable: true };
    expect(formatEntry(entry)).toBe('18:01:02.345 window       77 e5bb5bec window.turn.start  label=thinking steerable=true');
    expect(matches(entry, { session: 'e5bb' }, undefined)).toBe(true);
    expect(matches(entry, { session: 'ffff' }, undefined)).toBe(false);
    expect(matches(entry, { role: 'worker' }, undefined)).toBe(false);
    const now = Date.parse('2026-10-04T18:10:00Z');
    expect(matches(entry, {}, sinceCutoff('5m', now))).toBe(false);
    expect(matches(entry, {}, sinceCutoff('10m', now))).toBe(true);
    expect(sinceCutoff('soon')).toBeUndefined();
  });
});
