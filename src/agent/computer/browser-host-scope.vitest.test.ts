import { describe, expect, it } from 'vitest';
import { browserHostLaunch, browserHostLimits } from './browser-host-scope.js';

const inUserManager = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/x.scope\n';
const outside = '0::/user.slice/user-1000.slice/session-3.scope\n';
const base = { platform: 'linux' as const, env: { HOME: '/h' } as NodeJS.ProcessEnv, cgroup: inUserManager, uid: 1000, cwd: '/w', busExists: () => true };

describe('browserHostLaunch', () => {
  it('starts the host in a scope of its own under the agent slice with 8G/10G, task and cpu limits', () => {
    const launch = browserHostLaunch(['node', 'cli.js', 'computer-host', '/state'], base)!;
    expect(launch.argv.slice(0, 5)).toEqual(['systemd-run', '--user', '--quiet', '--collect', '--scope']);
    expect(launch.argv).toContain('--unit=clikcode-browser-host');
    expect(launch.argv).toContain('--slice=clikcode.slice');
    for (const property of ['MemoryHigh=8G', 'MemoryMax=10G', 'TasksMax=16384', 'CPUQuota=400%', 'OOMPolicy=continue']) expect(launch.argv).toContain(property);
    expect(launch.argv.slice(launch.argv.indexOf('--') + 1)).toEqual(['node', 'cli.js', 'computer-host', '/state']);
    expect(launch.detachesAtOnce).toBe(false);
  });
  it('uses a service the user manager starts when the caller is outside it, carrying the environment', () => {
    const launch = browserHostLaunch(['node', 'x'], { ...base, cgroup: outside, env: { DISPLAY: ':1' } })!;
    expect(launch.argv).not.toContain('--scope');
    expect(launch.argv).toContain('--setenv=DISPLAY=:1');
    expect(launch.argv).toContain('--working-directory=/w');
    expect(launch.detachesAtOnce).toBe(true);
  });
  it('starts plainly off Linux, with no user bus, or when scopes are turned off', () => {
    expect(browserHostLaunch(['node'], { ...base, platform: 'darwin' })).toBeUndefined();
    expect(browserHostLaunch(['node'], { ...base, busExists: () => false })).toBeUndefined();
    expect(browserHostLaunch(['node'], { ...base, env: { CLIKCODE_OWN_SCOPE: '0' } })).toBeUndefined();
  });
  it('reads limits from the environment and ignores nonsense', () => {
    expect(browserHostLimits({ CLIKCODE_BROWSER_MEMORY_HIGH: '4G', CLIKCODE_BROWSER_MEMORY_MAX: '$(rm -rf)', CLIKCODE_BROWSER_CPU_PERCENT: '200' }))
      .toEqual({ memoryHigh: '4G', memoryMax: '10G', tasksMax: '16384', cpuQuota: '200%' });
  });
});
