import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CgroupReaders } from './cgroup-inspect.js';
import { parseScopeName, reap, reapTargets, renderScopeReport, scanSlice } from './scope-report.js';

const H = 3_600_000;
const now = 1_000 * H;
let slice: string;
beforeEach(() => { slice = mkdtempSync(join(tmpdir(), 'scopes-')); });
afterEach(() => { rmSync(slice, { recursive: true, force: true }); });

function cgroup(dir: string, files: Record<string, string>) { mkdirSync(dir, { recursive: true }); for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text); }
const procs: Record<number, { agoH: number; cmd: string }> = {
  1556452: { agoH: 60, cmd: 'node cli session-worker abc' }, // the old worker generation
  50: { agoH: 59, cmd: 'bash -c while true; do awk x; done' }, 51: { agoH: 59, cmd: 'awk x' },
  60: { agoH: 1, cmd: 'npm test' },
  77: { agoH: 2, cmd: 'vendor-child' },
  90: { agoH: 70, cmd: 'bash ./run # clikcode:keep' },
  3357142: { agoH: 1, cmd: 'node cli session-worker def' },
};
const read: CgroupReaders = {
  pids: (dir) => { try { return readFileSync(join(dir, 'cgroup.procs'), 'utf8').split('\n').filter(Boolean).map(Number); } catch { return []; } },
  startedAt: (pid) => (procs[pid] ? now - procs[pid]!.agoH * H : undefined),
  commandLine: (pid) => procs[pid]?.cmd,
  file: (path) => { try { return readFileSync(path, 'utf8'); } catch { return undefined; } },
};
// cpu: the two samples differ by 1 s of cpu on the hot group, nothing on the others
let tick = 0;
const cpuFile = () => `usage_usec ${tick * 990_000}\n`;

async function build() {
  const old = join(slice, 'clikcode-worker-abc-1556452.scope');
  cgroup(old, { 'cgroup.procs': '', 'memory.current': String(16.6 * 2 ** 30), 'pids.current': '3217' });
  cgroup(join(old, 'agent'), { 'cgroup.procs': '' });
  cgroup(join(old, 'cmd-50'), { 'cgroup.procs': '50\n51', 'memory.current': '1000000' });
  cgroup(join(old, 'cmd-60'), { 'cgroup.procs': '60' });
  cgroup(join(old, 'cmd-90'), { 'cgroup.procs': '90' });
  const live = join(slice, 'clikcode-worker-def-3357142.scope');
  cgroup(live, { 'cgroup.procs': '3357142\n77', 'memory.current': '500000000' });
  cgroup(join(slice, 'clikcode-browser-host.scope'), { 'cgroup.procs': '77', 'memory.current': String(3 * 2 ** 30) });
  const dead = join(slice, 'clikcode-worker-gone-999.scope');
  cgroup(dead, { 'cgroup.procs': '77' });
}

describe('scope report', () => {
  it('reads the scope name', () => {
    expect(parseScopeName('clikcode-worker-de679bc3-f5e2-43dd-42.scope')).toEqual({ kind: 'worker', sessionId: 'de679bc3-f5e2-43dd', workerPid: 42 });
    expect(parseScopeName('clikcode-browser-host.scope').kind).toBe('browser-host');
    expect(parseScopeName('run-r1.scope').kind).toBe('other');
  });

  it('lists scopes with memory, tasks, age and owner, flags the 59 h loop, spares the keep-marked one, and finds an orphan', async () => {
    await build();
    const rows = await scanSlice(slice, { now, maxMs: 2 * H, read, names: new Map([['abc', 'Fix the deploy']]), pause: async () => { tick = 1; } });
    const old = rows.find((row) => row.unit.includes('abc'))!;
    expect(old.owner).toBe('Fix the deploy');
    expect(old.workerAlive).toBe(true);
    expect(old.facts.memoryBytes).toBeGreaterThan(16 * 2 ** 30);
    expect(old.facts.tasks).toBe(3217);
    expect(old.commands.map((c) => [c.group, c.flag])).toEqual([['cmd-50', 'over its lifetime'], ['cmd-60', undefined], ['cmd-90', undefined]]);
    expect(old.commands.find((c) => c.group === 'cmd-50')!.facts.ageMs).toBe(59 * H + 1_000);
    const orphan = rows.find((row) => row.unit.includes('gone'))!;
    expect(orphan.orphaned).toBe(true);
    expect(rows.find((row) => row.unit.includes('def'))!.orphaned).toBe(false);
    expect(rows.find((row) => row.unit.includes('browser'))!.kind).toBe('browser-host');
    const text = renderScopeReport(rows, 2 * H);
    expect(text).toContain('ORPHANED');
    expect(text).toMatch(/! cmd-50 · age 59 h/);
    expect(text).toContain('worker 1556452 alive');
  });

  it('flags a loop as hot when its cgroup used a core between the two samples', async () => {
    await build();
    writeFileSync(join(slice, 'clikcode-worker-abc-1556452.scope', 'cmd-50', 'cpu.stat'), cpuFile());
    tick = 0;
    const rows = await scanSlice(slice, {
      now, maxMs: 2 * H, read: { ...read, file: (path) => (path.endsWith('cmd-50/cpu.stat') ? cpuFile() : read.file(path)) },
      pause: async () => { tick = 1; },
    });
    const command = rows.find((row) => row.unit.includes('abc'))!.commands.find((c) => c.group === 'cmd-50')!;
    expect(Math.round(command.cpuPercent!)).toBe(99);
    expect(command.flag).toBe('hot past its lifetime');
  });

  it('lists an orphan younger than the lifetime without ending it, and never a scope holding the browser host', async () => {
    await build();
    const saved = procs[77];
    procs[77] = { agoH: 1, cmd: 'vendor-child' };
    procs[78] = { agoH: 100, cmd: 'node cli computer-host /s' };
    const host = join(slice, 'clikcode-worker-host-5.scope');
    cgroup(host, { 'cgroup.procs': '78' });
    try {
      const rows = await scanSlice(slice, { now, maxMs: 2 * H, read, pause: async () => undefined });
      expect(rows.find((row) => row.unit.includes('gone'))!.orphaned).toBe(true);
      const labels = reapTargets(rows, 2 * H).map((t) => t.label);
      expect(labels).not.toContain('clikcode-worker-gone-999.scope');
      expect(labels.filter((l) => l.includes('host-5'))).toEqual([]);
    } finally { procs[77] = saved!; delete procs[78]; }
  });

  it('reaps only what is flagged', async () => {
    await build();
    const rows = await scanSlice(slice, { now, maxMs: 2 * H, read, pause: async () => undefined });
    const targets = reapTargets(rows, 2 * H);
    expect(targets.map((t) => t.label).sort()).toEqual(['clikcode-worker-abc-1556452.scope/cmd-50', 'clikcode-worker-gone-999.scope']);
    const killed: string[] = [];
    expect(reap(targets, (dir) => { killed.push(dir); return true; })).toHaveLength(2);
    expect(killed).not.toContain(join(slice, 'clikcode-worker-def-3357142.scope'));
  });
});
