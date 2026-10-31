import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptArgs, AGENT_SLICE, agentSliceDirectory, ceilingUpdate, installSystemdRunShim, scopeUnitName, sliceArgs, systemdRunArgs, userManagerLaunch, workerLimits, userManagerOwns } from './own-scope.js';

describe('own scope', () => {
  it('names a valid, per-process unit from any session id', () => {
    expect(scopeUnitName('de679bc3-f5e2-43dd', 42)).toBe('clikcode-worker-de679bc3-f5e2-43dd-42.scope');
    expect(scopeUnitName('a b/c@d', 7)).toBe('clikcode-worker-a_b_c_d-7.scope');
  });

  it('adopts the given pid into the agent slice', () => {
    const args = adoptArgs('u.scope', 99);
    expect(args.slice(args.indexOf('PIDs'), args.indexOf('PIDs') + 4)).toEqual(['PIDs', 'au', '1', '99']);
    expect(args.slice(args.indexOf('Slice'), args.indexOf('Slice') + 3)).toEqual(['Slice', 's', AGENT_SLICE]);
    expect(args[args.indexOf('StartTransientUnit') + 2]).toBe('u.scope');
  });

  it('bounds a worker scope by a wide soft memory line and a task count, never a hard kill line', () => {
    const args = adoptArgs('u.scope', 99, workerLimits(1000, {}));
    const prop = (name: string) => args.slice(args.indexOf(name), args.indexOf(name) + 3);
    expect(prop('MemoryHigh')).toEqual(['MemoryHigh', 't', '500']);
    expect(prop('TasksMax')).toEqual(['TasksMax', 't', '16384']);
    expect(args).not.toContain('MemoryMax');
    expect(args[args.indexOf('u.scope') + 2]).toBe('7');
  });

  it('reads the worker limits from the environment, and can drop the memory line', () => {
    expect(workerLimits(1000, { CLIKCODE_WORKER_MEMORY_HIGH_SHARE: '0.25', CLIKCODE_WORKER_TASKS_MAX: '500' })).toEqual({ memoryHigh: 250, tasksMax: 500 });
    const off = adoptArgs('u.scope', 99, workerLimits(1000, { CLIKCODE_WORKER_MEMORY_HIGH_SHARE: '0' }));
    expect(off).not.toContain('MemoryHigh');
    expect(off[off.indexOf('u.scope') + 2]).toBe('6');
  });

  it('moves only processes the user manager owns', () => {
    expect(userManagerOwns('0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-code-1.scope\n')).toBe(true);
    expect(userManagerOwns('0::/user.slice/user-1000.slice/session-4.scope\n')).toBe(false);
    expect(userManagerOwns('0::/system.slice/tailscaled.service\n')).toBe(false);
    expect(userManagerOwns('')).toBe(false);
  });

  it('creates the agent slice with a hard cap and a swap cap, and no soft throttle', () => {
    const args = sliceArgs(1000);
    const prop = (name: string) => args.slice(args.indexOf(name), args.indexOf(name) + 3);
    expect(args[args.indexOf('StartTransientUnit') + 2]).toBe(AGENT_SLICE);
    expect(args).not.toContain('MemoryHigh');
    expect(prop('MemoryMax')).toEqual(['MemoryMax', 't', '800']);
    expect(prop('MemorySwapMax')).toEqual(['MemorySwapMax', 't', '100']);
    expect(args[args.indexOf(AGENT_SLICE) + 2]).toBe('3');
  });

  it('keeps the worker when one process in its scope is killed at the ceiling', () => {
    const args = adoptArgs('u.scope', 99);
    expect(args.slice(args.indexOf('OOMPolicy'), args.indexOf('OOMPolicy') + 3)).toEqual(['OOMPolicy', 's', 'continue']);
  });

  it('caps a running slice only while it has no cap and is under that cap', () => {
    expect(ceilingUpdate('max', 'max', 1000, 100)).toEqual({ max: 800, swap: 100 });
    expect(ceilingUpdate('500', 'max', 1000, 100)).toEqual({ swap: 100 });
    expect(ceilingUpdate('max', 'max', 1000, 900)).toBeUndefined();
    expect(ceilingUpdate('700', '50', 1000, 100)).toBeUndefined();
  });

  it('places an agent systemd-run in the agent slice without adding a cap', () => {
    expect(systemdRunArgs(['--user', '--scope', '--quiet', 'vitest'], 9)).toEqual(['--slice=clikcode.slice', '--setenv=CLIKCODE_WORKER_PID=9', '--user', '--scope', '--quiet', 'vitest']);
    expect(systemdRunArgs(['--user', '--slice=app.slice', 'true'], 9)).toEqual(['--user', '--slice=app.slice', 'true']);
    expect(systemdRunArgs(['true'], 9)).toEqual(['true']);
    const home = mkdtempSync(join(tmpdir(), 'clikcode-shim-'));
    const saved = { home: process.env.CLIKCODE_HOME, path: process.env.PATH };
    process.env.CLIKCODE_HOME = home;
    try {
      installSystemdRunShim();
      const ran = spawnSync(join(home, 'bin', 'systemd-run'), ['--user', '--scope', 'vitest'], { encoding: 'utf8', env: { ...process.env, SYSTEMD_RUN: 'echo', CLIKCODE_WORKER_PID: '9' } });
      expect(ran.stdout.trim()).toBe('--slice=clikcode.slice --setenv=CLIKCODE_WORKER_PID=9 --user --scope vitest');
    } finally {
      if (saved.home === undefined) delete process.env.CLIKCODE_HOME; else process.env.CLIKCODE_HOME = saved.home;
      if (saved.path === undefined) delete process.env.PATH; else process.env.PATH = saved.path;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('finds the agent slice under the user manager, beside app.slice', () => {
    expect(agentSliceDirectory('0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-code-1.scope\n'))
      .toBe('/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/clikcode.slice');
    expect(agentSliceDirectory('0::/system.slice/tailscaled.service\n')).toBeUndefined();
  });

  const sshSession = '0::/user.slice/user-1000.slice/session-145.scope\n';
  const launchContext = (over: Partial<Parameters<typeof userManagerLaunch>[1]> = {}) => ({
    cgroup: sshSession, uid: 1000, env: { HOME: '/home/u', CLIKCODE_HOME: '/h' }, cwd: '/work', execPath: '/bin/node',
    unit: 'clikcode-start-x.service', busExists: () => true, ...over,
  });

  it('starts a worker from an SSH session through the user manager, into the agent slice, with this window\'s environment and folder', () => {
    const launch = userManagerLaunch(['/x/index.js', 'session-worker', 's1'], launchContext())!;
    expect(launch.command).toBe('systemd-run');
    expect(launch.args).toEqual(expect.arrayContaining(['--user', '--collect', `--slice=${AGENT_SLICE}`, 'OOMPolicy=continue',
      '--working-directory=/work', '--setenv=HOME=/home/u', '--setenv=CLIKCODE_HOME=/h']));
    expect(launch.args.slice(launch.args.indexOf('--'))).toEqual(['--', '/bin/node', '/x/index.js', 'session-worker', 's1']);
    // Tailscale SSH sets no runtime dir: the user's own is used to reach the manager.
    expect(launch.env.XDG_RUNTIME_DIR).toBe('/run/user/1000');
  });

  it('leaves every other start alone: already under the user manager, no user bus, or turned off', () => {
    expect(userManagerLaunch([], launchContext({ cgroup: '0::/user.slice/user-1000.slice/user@1000.service/app.slice/x.scope\n' }))).toBeUndefined();
    expect(userManagerLaunch([], launchContext({ busExists: () => false }))).toBeUndefined();
    expect(userManagerLaunch([], launchContext({ env: { CLIKCODE_OWN_SCOPE: '0' } }))).toBeUndefined();
    expect(userManagerLaunch([], launchContext({ cgroup: '' }))).toBeUndefined();
  });

  const userBus = `${process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}`}/bus`;
  it.skipIf(process.platform !== 'linux' || !existsSync(userBus))('really lands the process in the agent slice, in its folder, with its environment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clikcode-launch-'));
    try {
      const out = join(dir, 'seen');
      const launch = userManagerLaunch(['-e', `require('fs').writeFileSync(${JSON.stringify(out)}, [require('fs').readFileSync('/proc/self/cgroup','utf8').trim(), process.cwd(), process.env.CLIKCODE_PROBE].join('|'))`], {
        cgroup: sshSession, uid: process.getuid!(), env: { ...process.env, CLIKCODE_PROBE: 'carried' }, cwd: dir, execPath: process.execPath,
        unit: `clikcode-launch-test-${process.pid}-${Date.now()}.service`, busExists: existsSync,
      })!;
      expect(spawnSync(launch.command, launch.args, { env: launch.env }).status).toBe(0);
      const deadline = Date.now() + 10_000;
      while (!existsSync(out) && Date.now() < deadline) spawnSync('sleep', ['0.05']);
      const [cgroup, cwd, probe] = readFileSync(out, 'utf8').split('|');
      expect(cgroup).toContain(`/${AGENT_SLICE}/clikcode-launch-test-`);
      expect([cwd, probe]).toEqual([dir, 'carried']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
