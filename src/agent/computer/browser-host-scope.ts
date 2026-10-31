/** Starts the browser host in a systemd unit of its own, under the agent slice, with memory, task and cpu limits.
 *
 * MEASURED 2026-10-31: the host was started by whichever worker first needed a browser and so lived inside that worker's
 * scope (cmd-1903026 of an old worker generation): 2d11h later that one scope held 16.6 GB and 3,217 tasks with no limit, and
 * stopping or accounting for that worker meant stopping Chrome. In a unit of its own the host belongs to no worker: it
 * outlives the one that started it, the next worker adopts it through the profile's DevToolsActivePort as before, and a
 * runaway Chrome is throttled at MemoryHigh and killed at MemoryMax inside its own unit instead of eating the slice.
 *
 * Linux under a systemd user manager only; anywhere else (or CLIKCODE_OWN_SCOPE=0) the host starts as it always did. */
import { AGENT_SLICE, userManagerOwns } from '../../worker/own-scope.js';

export const BROWSER_HOST_UNIT = 'clikcode-browser-host';

const SIZE = /^(?:\d+(?:\.\d+)?[KMGT]?|infinity)$/i;
const setting = (value: string | undefined, fallback: string): string => (value && SIZE.test(value.trim()) ? value.trim() : fallback);

export interface BrowserHostLimits { memoryHigh: string; memoryMax: string; tasksMax: string; cpuQuota: string }

/** 8 GB soft, 10 GB hard, 16384 tasks (threads count), 4 cores. CLIKCODE_BROWSER_MEMORY_HIGH / _MEMORY_MAX / _TASKS_MAX / _CPU_PERCENT change them. */
export function browserHostLimits(env: NodeJS.ProcessEnv = process.env): BrowserHostLimits {
  const percent = Number(env.CLIKCODE_BROWSER_CPU_PERCENT);
  return {
    memoryHigh: setting(env.CLIKCODE_BROWSER_MEMORY_HIGH, '8G'),
    memoryMax: setting(env.CLIKCODE_BROWSER_MEMORY_MAX, '10G'),
    tasksMax: setting(env.CLIKCODE_BROWSER_TASKS_MAX, '16384'),
    cpuQuota: `${Number.isFinite(percent) && percent > 0 ? Math.floor(percent) : 400}%`,
  };
}

export interface HostLaunchContext {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** /proc/self/cgroup of the process that starts the host. */
  cgroup: string;
  uid: number;
  cwd: string;
  busExists: (path: string) => boolean;
}

export interface HostLaunch { argv: string[]; env: NodeJS.ProcessEnv; /** systemd-run exits as soon as the unit is started (a service), not when the host ends (a scope). */ detachesAtOnce: boolean }

/** The command that starts `hostArgv` in its own unit, or undefined where it should start plainly. */
export function browserHostLaunch(hostArgv: readonly string[], context: HostLaunchContext, limits: BrowserHostLimits = browserHostLimits(context.env)): HostLaunch | undefined {
  if (context.platform !== 'linux' || context.env.CLIKCODE_OWN_SCOPE === '0' || !context.cgroup) return undefined;
  const runtime = context.env.XDG_RUNTIME_DIR || `/run/user/${context.uid}`;
  if (!context.busExists(`${runtime}/bus`)) return undefined;
  // A process the user manager owns can start a scope. One outside it (ssh, Remote-SSH) cannot be moved, so the manager starts a service.
  const scope = userManagerOwns(context.cgroup);
  const limitArgs = ['-p', `MemoryHigh=${limits.memoryHigh}`, '-p', `MemoryMax=${limits.memoryMax}`, '-p', `TasksMax=${limits.tasksMax}`, '-p', `CPUQuota=${limits.cpuQuota}`, '-p', 'OOMPolicy=continue'];
  const setenv = scope ? [] : Object.entries(context.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !entry[1].includes('\0')).map(([key, value]) => `--setenv=${key}=${value}`);
  return {
    argv: ['systemd-run', '--user', '--quiet', '--collect', ...(scope ? ['--scope'] : [`--working-directory=${context.cwd}`, '-p', 'StandardOutput=null', '-p', 'StandardError=null']),
      `--unit=${BROWSER_HOST_UNIT}`, `--slice=${AGENT_SLICE}`, ...limitArgs, ...setenv, '--', ...hostArgv],
    env: { ...context.env, XDG_RUNTIME_DIR: runtime },
    detachesAtOnce: !scope,
  };
}
