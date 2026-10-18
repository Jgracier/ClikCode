import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cgroupFreeable, sliceInventory, workerPidFromEnv } from './resource-probes.js';
import { AGENT_GROUP } from './command-groups.js';
import { WORKER_PID_ENV } from './own-scope.js';
import type { ProcInfo } from './command-groups.js';

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

const file = (path: string, text: string): void => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };

/** A cgroup tree as the kernel shows it: a slice, a worker's scope divided into its agent group and
 * one group per command, and a systemd-run scope the shim tagged with the worker's pid. */
function slice(): string {
  root = mkdtempSync(join(tmpdir(), 'clikcode-slice-'));
  const scope = join(root, 'clikcode-worker-abc-41943100.scope');
  file(join(scope, AGENT_GROUP, 'cgroup.procs'), '41943100\n');
  file(join(scope, 'cmd-41943200', 'cgroup.procs'), '41943200\n41943201\n');
  file(join(scope, 'cmd-41943200', 'memory.stat'), 'anon 3145728\nfile 999\n');
  file(join(scope, 'cmd-41943200', 'memory.swap.current'), '1048576\n');
  file(join(root, 'run-u7.scope', 'cgroup.procs'), '41943300\n');
  file(join(root, 'run-u7.scope', 'memory.stat'), 'anon 2097152\n');
  file(join(root, 'run-u8.scope', 'cgroup.procs'), '41943400\n');
  file(join(root, 'other.scope', 'cgroup.procs'), '41943500\n');
  return root;
}

const procs: Record<number, ProcInfo> = {
  41943100: { pid: 41943100, ppid: 1, exe: 'node', command: 'node /x/clikcode session-worker abc' },
  41943200: { pid: 41943200, ppid: 41943100, exe: 'bash', command: 'bash -c npm test' },
  41943201: { pid: 41943201, ppid: 41943200, exe: 'node', command: 'node vitest' },
  41943300: { pid: 41943300, ppid: 1, exe: 'docker', command: 'docker build .' },
  41943400: { pid: 41943400, ppid: 1, exe: 'sleep', command: 'sleep 99' },
};

describe('what agents run, read from the slice', () => {
  it('finds the worker, each command group it owns, and a scope tagged with its pid -- nothing else', () => {
    const dir = slice();
    const env = (pid: number): string | undefined => (pid === 41943300 ? `PATH=/bin\0${WORKER_PID_ENV}=41943100\0` : pid === 41943400 ? 'PATH=/bin\0' : undefined);
    const inventory = sliceInventory(dir, (pid) => procs[pid], undefined, env);
    expect(inventory.workers).toEqual([41943100]);
    const groups = inventory.units.map((unit) => ({ target: 'cgroup' in unit.target ? unit.target.cgroup.replace(dir, '') : '', owner: unit.owner, freeable: unit.freeable }));
    expect(groups).toEqual([
      { target: '/clikcode-worker-abc-41943100.scope/cmd-41943200', owner: 41943100, freeable: 4 * 1024 * 1024 },
      { target: '/run-u7.scope', owner: 41943100, freeable: 2 * 1024 * 1024 },
    ]);
  });

  it('frees what a group charges here: anonymous memory and swap', () => {
    const dir = slice();
    expect(cgroupFreeable(join(dir, 'clikcode-worker-abc-41943100.scope', 'cmd-41943200'))).toBe(4 * 1024 * 1024);
    expect(cgroupFreeable(join(dir, 'missing'))).toBe(0);
  });

  it('reads the worker pid only from its own variable, and only a number', () => {
    expect(workerPidFromEnv(`A=1\0${WORKER_PID_ENV}=42\0`)).toBe(42);
    expect(workerPidFromEnv(`${WORKER_PID_ENV}=4x2\0`)).toBeUndefined();
    expect(workerPidFromEnv('A=1\0')).toBeUndefined();
  });
});
