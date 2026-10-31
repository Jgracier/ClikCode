/** A command lives at most a set time, enforced from its own cgroup.
 *
 * MEASURED 2026-10-31: an `awk` loop ran at 99% cpu for 38 h in `cmd-2018538` of a worker scope. The earlier reaping
 * (harness/transport/background-commands.ts, c3ba8b4a) works by pid for commands the current worker tracks; this command
 * belonged to an older worker generation and nothing tracked it. The cgroup is the one record that cannot be lost: each
 * command is in a `cmd-<pid>` group (command-groups.ts), the age of its oldest process is the command's age, and
 * `cgroup.kill` ends exactly it. A command that carries the keep mark (clikcode:keep) is exempt.
 * CLIKCODE_COMMAND_MAX_MS changes the 2 h (0 or unset keeps it). */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { lifecycle } from '../runtime/lifecycle-log.js';
import { cgroupFacts, killCgroup, realReaders, type CgroupFacts, type CgroupReaders } from './cgroup-inspect.js';
import { COMMAND_GROUP } from './command-groups.js';

export const DEFAULT_COMMAND_MAX_MS = 2 * 3_600_000;

export function commandMaxMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.CLIKCODE_COMMAND_MAX_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_COMMAND_MAX_MS;
}

/** Why this command has outlived its time, or undefined. `labelKeep`: the worker remembers the agent's label with the keep mark. */
export function lifetimeVerdict(facts: CgroupFacts, maxMs: number, labelKeep = false): string | undefined {
  if (facts.keep || labelKeep || facts.ageMs === undefined || facts.pids === 0) return undefined;
  return facts.ageMs >= maxMs ? `ran ${hours(facts.ageMs)}, over the ${hours(maxMs)} limit` : undefined;
}

export const hours = (ms: number): string => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(ms >= 36_000_000 ? 0 : 1)} h` : `${Math.round(ms / 60_000)} min`);

export interface LifetimeOptions {
  now?: number;
  maxMs?: number;
  read?: CgroupReaders;
  kill?: (dir: string) => boolean;
  /** What the agent ran, by group name, as the worker remembers it. */
  labels?: ReadonlyMap<string, string>;
  /** Told to the conversation's agent. */
  deliver?: (note: string) => void;
  list?: (scopeDir: string) => string[];
}

export interface LifetimeKill { group: string; reason: string; command: string }

/** Ends every command group in `scopeDir` that has run past its limit. Returns what it ended. */
export function enforceCommandLifetimes(scopeDir: string, options: LifetimeOptions = {}): LifetimeKill[] {
  const now = options.now ?? Date.now();
  const maxMs = options.maxMs ?? commandMaxMs();
  const read = options.read ?? realReaders;
  const names = (options.list ?? ((dir) => { try { return readdirSync(dir); } catch { return []; } }))(scopeDir).filter((name) => COMMAND_GROUP.test(name));
  const ended: LifetimeKill[] = [];
  for (const group of names) {
    const dir = join(scopeDir, group);
    const facts = cgroupFacts(dir, now, read);
    const label = options.labels?.get(group);
    const reason = lifetimeVerdict(facts, maxMs, label?.includes('clikcode:keep') ?? false);
    if (!reason) continue;
    const command = (label || facts.command || group).slice(0, 160);
    if (!(options.kill ?? killCgroup)(dir)) continue;
    lifecycle('command.lifetime.killed', { group, reason, ageMs: facts.ageMs, pids: facts.pids, command: command.slice(0, 80) });
    options.deliver?.(`ClikCode ended a command that ${reason}: ${command}. Commands are limited to ${hours(maxMs)}; add the text "clikcode:keep" to a command that must run longer.`);
    ended.push({ group, reason, command });
  }
  return ended;
}

/** The same over every worker scope in the agent slice -- the caller's own (with its remembered labels) and those of other or
 * older workers, which nothing else supervises. */
export function enforceInSlice(sliceDir: string, own: { scopeDir: string; labels: ReadonlyMap<string, string> }, options: Omit<LifetimeOptions, 'labels'> = {}): LifetimeKill[] {
  let scopes: string[] = [];
  try { scopes = readdirSync(sliceDir).filter((name) => /^clikcode-worker-.+\.scope$/.test(name)).map((name) => join(sliceDir, name)); } catch { /* fail-open-ok: no slice */ }
  if (!scopes.includes(own.scopeDir)) scopes.push(own.scopeDir);
  return scopes.flatMap((scopeDir) => enforceCommandLifetimes(scopeDir, { ...options, ...(scopeDir === own.scopeDir ? { labels: own.labels } : {}) }));
}
