import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CgroupReaders } from './cgroup-inspect.js';
import { cgroupFacts } from './cgroup-inspect.js';
import { commandMaxMs, enforceCommandLifetimes, enforceInSlice, lifetimeVerdict } from './command-lifetime.js';

const H = 3_600_000;
const now = 1_000 * H;
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'lifetime-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** A fake /proc: pid -> start time (hours ago) and command line; cgroups are directories listing their pids. */
function fake(procs: Record<number, { agoH: number; cmd: string }>): CgroupReaders {
  return {
    pids: (dir) => { try { return readFileSync(join(dir, 'cgroup.procs'), 'utf8').split('\n').filter(Boolean).map(Number); } catch { return []; } },
    startedAt: (pid) => (procs[pid] ? now - procs[pid]!.agoH * H : undefined),
    commandLine: (pid) => procs[pid]?.cmd,
    file: (path) => { try { return readFileSync(path, 'utf8'); } catch { return undefined; } },
  };
}
const group = (scope: string, name: string, pids: number[]) => { mkdirSync(join(scope, name), { recursive: true }); writeFileSync(join(scope, name, 'cgroup.procs'), pids.join('\n')); };

describe('command lifetime', () => {
  it('defaults to 2 hours and reads CLIKCODE_COMMAND_MAX_MS', () => {
    expect(commandMaxMs({})).toBe(2 * H);
    expect(commandMaxMs({ CLIKCODE_COMMAND_MAX_MS: '60000' })).toBe(60_000);
  });

  it('ends the runaway loop in its own cgroup though nothing tracks it, and says so', () => {
    const scope = join(root, 'clikcode-worker-old-1.scope');
    group(scope, 'cmd-10', [10, 11]);
    group(scope, 'cmd-20', [20]);
    const procs = { 10: { agoH: 38, cmd: 'bash -c while true; do awk x; done' }, 11: { agoH: 38, cmd: 'awk x' }, 20: { agoH: 0.5, cmd: 'npm test' } };
    const killed: string[] = [];
    const notes: string[] = [];
    const ended = enforceCommandLifetimes(scope, { now, read: fake(procs), kill: (dir) => { killed.push(dir); return true; }, deliver: (note) => notes.push(note) });
    expect(ended.map((entry) => entry.group)).toEqual(['cmd-10']);
    expect(killed).toEqual([join(scope, 'cmd-10')]);
    expect(notes[0]).toMatch(/ended a command that ran 38 h, over the 2\.0 h limit/);
  });

  it('spares a command marked clikcode:keep, by its command line or its remembered label', () => {
    const scope = join(root, 'clikcode-worker-a-1.scope');
    group(scope, 'cmd-1', [1]);
    group(scope, 'cmd-2', [2]);
    const procs = { 1: { agoH: 5, cmd: 'bash -c ./deploy.sh # clikcode:keep' }, 2: { agoH: 5, cmd: 'sleep 99999' } };
    const killed: string[] = [];
    enforceCommandLifetimes(scope, { now, read: fake(procs), kill: (dir) => { killed.push(dir); return true; }, labels: new Map([['cmd-2', 'sleep 99999 clikcode:keep']]) });
    expect(killed).toEqual([]);
  });

  it('does not touch a young command, an empty group, or what is not a command group', () => {
    const scope = join(root, 's');
    group(scope, 'cmd-3', []);
    group(scope, 'agent', [4]);
    expect(enforceCommandLifetimes(scope, { now, read: fake({ 4: { agoH: 99, cmd: 'node worker' } }), kill: () => true })).toEqual([]);
    expect(lifetimeVerdict({ pids: 1, keep: false, ageMs: 1 * H }, 2 * H)).toBeUndefined();
  });

  it('measures age by the oldest live process, so a finished shell does not hide an orphan loop', () => {
    const scope = join(root, 's');
    group(scope, 'cmd-5', [6]);
    const facts = cgroupFacts(join(scope, 'cmd-5'), now, fake({ 6: { agoH: 10, cmd: 'awk' } }));
    expect(facts.ageMs).toBe(10 * H);
  });

  it('sweeps the scopes of other and older workers in the slice too', () => {
    const slice = join(root, 'clikcode.slice');
    const mine = join(slice, 'clikcode-worker-me-5.scope');
    const old = join(slice, 'clikcode-worker-old-1.scope');
    group(mine, 'cmd-1', [1]);
    group(old, 'cmd-2', [2]);
    group(join(slice, 'run-x.scope'), 'cmd-3', [3]);
    const killed: string[] = [];
    enforceInSlice(slice, { scopeDir: mine, labels: new Map() }, { now, read: fake({ 1: { agoH: 3, cmd: 'a' }, 2: { agoH: 30, cmd: 'b' }, 3: { agoH: 30, cmd: 'c' } }), kill: (dir) => { killed.push(dir); return true; } });
    expect(killed.sort()).toEqual([join(mine, 'cmd-1'), join(old, 'cmd-2')].sort());
  });
});
