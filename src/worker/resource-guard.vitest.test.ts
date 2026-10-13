import { describe, expect, it } from 'vitest';
import { bestLabel } from './command-groups.js';
import { agentBudget, decideAction, desktopReserve, nudgeNote, stopNote } from './resource-guard.js';
import { parsePs, parseVmStat, parseWindowsProcesses, processProbe, tableInventory, workerPidFromEnv, type TableEntry, type Unit } from './resource-probes.js';

const GIB = 2 ** 30;
const entry = (pid: number, ppid: number, size: number, exe: string, command: string): TableEntry => ({ pid, ppid, bytes: size * GIB, exe, command });
const processes = [
  entry(100, 1, 0.2, 'node', 'node /x/dist/index.js session-worker aaaa'),
  entry(101, 100, 0.3, 'claude', '/opt/claude'),
  entry(102, 101, 0.01, 'bash', '/bin/bash -c vitest'),
  entry(103, 102, 2.4, 'node', 'node vitest'),
  entry(104, 103, 0.6, 'node', 'node vitest fork'),
  entry(105, 101, 0.01, 'sh', 'sh -c npx @upstash/context7-mcp'),
  entry(106, 105, 0.8, 'node', 'node context7-mcp'),
  entry(107, 106, 0.01, 'bash', 'bash -c internal-mcp-work'),
  entry(200, 1, 0.2, 'node', 'node /x/dist/index.js session-worker bbbb'),
  entry(201, 200, 0.3, 'codex', 'codex app-server'),
  entry(202, 201, 0.01, 'bash', 'bash -lc sleep 10'),
  entry(203, 202, 0.008, 'sleep', 'sleep 10'),
];

describe('resource guard', () => {
  it('reserves desktop memory, honoring the kernel ceiling and pressure', () => {
    expect(desktopReserve(57 * GIB)).toBeCloseTo(57 * GIB * 0.08);
    expect(desktopReserve(16 * GIB)).toBe(4 * GIB);
    expect(agentBudget({ total: 57 * GIB, available: 30 * GIB, used: 10 * GIB, ceiling: 20 * GIB, critical: false }).limit / GIB).toBeCloseTo(19.4);
    expect(agentBudget({ total: 57 * GIB, available: 30 * GIB, used: 10 * GIB, critical: true }).ratio).toBe(1);
  });

  it('stops an owned command that can free memory, never MCP machinery or a sleep', () => {
    const inventory = tableInventory(processes);
    expect(inventory.units.map((unit) => unit.label)).toEqual(['vitest', 'bash -lc sleep 10']);
    const over = { used: 36 * GIB, limit: 34 * GIB, ratio: 36 / 34 };
    const action = decideAction(over, inventory);
    expect(action.kind).toBe('stop');
    if (action.kind === 'stop') {
      expect(action.worker).toBe(100);
      expect(action.unit.freeable / GIB).toBeCloseTo(3.01);
      expect(action.unit.target).toMatchObject({ root: 102, pids: [102, 103, 104] });
      expect(stopNote(over, 2, action.unit)).toContain('do not rerun');
    }
    const sleepOnly = tableInventory(processes.filter((item) => ![102, 103, 104].includes(item.pid)));
    expect(decideAction(over, sleepOnly)).toEqual({ kind: 'nudge', worker: 200 });
    expect(nudgeNote(over, 2)).not.toContain('sleep');
    expect(nudgeNote(over, 2, sleepOnly.units[0])).toContain('Prefer targeted tests');
    const agentOnly = tableInventory(processes.filter((item) => [100, 101, 200, 201].includes(item.pid)));
    expect(decideAction(over, agentOnly)).toEqual({ kind: 'nudge', worker: 100 });
  });

  it('parses macOS and Windows process lists and only stops a freshly revalidated tree', async () => {
    const mac = parsePs(' 100 1 300000 node node /x/dist/index.js session-worker aaaa\n 101 100 200000 claude claude\n 102 101 20000 bash bash -c vitest\n 103 102 2000000 node node vitest');
    expect(tableInventory(mac).units[0]?.target).toMatchObject({ root: 102, pids: [102, 103] });
    const win = parseWindowsProcesses(JSON.stringify([
      { ProcessId: 100, ParentProcessId: 1, WorkingSetSize: 300000000, Name: 'node.exe', CommandLine: 'node C:\\x\\dist\\index.js session-worker aaaa', CreationDate: '2026-10-13T14:00:00' },
      { ProcessId: 101, ParentProcessId: 100, WorkingSetSize: 200000000, Name: 'claude.exe', CommandLine: 'claude', CreationDate: '2026-10-13T14:00:01' },
      { ProcessId: 102, ParentProcessId: 101, WorkingSetSize: 20000000, Name: 'cmd.exe', CommandLine: 'cmd /c vitest', CreationDate: '2026-10-13T14:00:02' },
      { ProcessId: 103, ParentProcessId: 102, WorkingSetSize: 2000000000, Name: 'node.exe', CommandLine: 'node vitest', CreationDate: '2026-10-13T14:00:03' },
    ]));
    expect(win[2]?.startedAt).toBe('2026-10-13T14:00:02');
    expect(win[2]?.command).toBe('cmd /c vitest');
    expect(parseWindowsProcesses('{bad')).toEqual([]);
    expect(parseWindowsProcesses(JSON.stringify({ ProcessId: 9, ParentProcessId: 1, WorkingSetSize: 1, Name: 'cmd.exe', CommandLine: 'cmd', CreationDate: '/Date(1760000000000)/' }))[0]?.startedAt).toBe('2025-10-09T08:53:20.000Z');
    expect(tableInventory(win).units[0]?.target).toMatchObject({ root: 102, pids: [102, 103] });
    const staleParent = win.map((item) => item.pid === 101 ? { ...item, startedAt: '2026-10-13T14:10:00' } : item);
    expect(tableInventory(staleParent).units).toEqual([]);
    let stopped = 0;
    let current = win;
    const probe = processProbe('win32', { readTable: () => current, stopTree: () => { stopped++; return true; } });
    const target = (await probe.inventory()).units[0]!.target;
    expect(await probe.stop(target)).toBe(true);
    current = current.map((item) => item.pid === 102 ? { ...item, startedAt: '2026-10-13T14:05:02' } : item);
    expect(await probe.stop(target)).toBe(false);
    expect(stopped).toBe(1);
    const macProbe = processProbe('darwin', {
      readTable: () => mac,
      readMemory: () => ({ total: 16 * GIB, available: 2 * GIB, used: 14 * GIB, critical: false }),
      stopTree: () => { stopped++; return true; },
    });
    const macBudget = agentBudget((await macProbe.sample())!);
    expect(macBudget.ratio).toBeGreaterThan(1);
    const macInventory = await macProbe.inventory();
    const macUnit = macInventory.units[0]!;
    expect(decideAction(macBudget, macInventory)).toMatchObject({ kind: 'stop', worker: 100 });
    expect(await macProbe.stop(macUnit.target)).toBe(true);
    expect(stopped).toBe(2);
  });

  it('stops a tagged scope the guard can see, and reads only the shim tag', () => {
    expect(workerPidFromEnv('HOME=/\0CLIKCODE_WORKER_PID=42\0PATH=/bin')).toBe(42);
    expect(workerPidFromEnv('CLIKCODE_WORKER_PID=nope')).toBeUndefined();
    const scope: Unit = { kind: 'command', target: { cgroup: '/run' }, label: 'vitest run', freeable: 8 * GIB };
    const over = { used: 40 * GIB, limit: 30 * GIB, ratio: 40 / 30 };
    expect(decideAction(over, { units: [scope], workers: [100, 200] })).toMatchObject({ kind: 'stop', worker: 100, unit: scope });
  });

  it('names the program the agent started, including after its shell wrapper is gone', () => {
    const shell = { pid: 1, ppid: 0, exe: 'bash', command: "/bin/bash -O extglob -c IFS= builtin read -r -d '' __grok_user_cmd" };
    const child = { pid: 2, ppid: 1, exe: 'node', command: 'node vitest run src/a.ts' };
    expect(bestLabel(shell, [child])).toBe('node vitest run src/a.ts');
    expect(bestLabel(undefined, [], 'bash /tmp/seqpush.sh')).toBe('bash /tmp/seqpush.sh');
    expect(bestLabel(undefined, [], "/bin/bash -c IFS= builtin read __grok_user_cmd")).toBe('');
  });

  it('counts reclaimable macOS pages as available', () => {
    expect(parseVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 100.\nPages inactive: 200.\nPages speculative: 50.\nPages purgeable: 25.')).toBe(375 * 16384);
  });
});
