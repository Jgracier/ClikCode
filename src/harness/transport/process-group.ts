/** Which processes belong to a vendor child's process group, and which of
 * them are work a tool call left running.
 *
 * A persistent vendor (ACP, Codex app-server) is spawned detached, so it and
 * everything it starts share its process group. Work it leaves running
 * between turns -- Claude Code's `run_in_background` shell under ACP, a dev
 * server -- reports as a finished tool call ("started in the background") and
 * nothing in the protocol says it is still going. Its processes do. But so do
 * the vendor's own long-lived helpers -- MCP servers, language servers --
 * which some vendors (Copilot) start lazily at the first prompt: counting
 * "anything new in the group" as work held a worker up forever and reported
 * those helpers as stopped work on every rebuild. `toolCallWork` is the one
 * definition. Read from /proc on Linux (no process spawned), from one `ps`
 * elsewhere on Unix; Windows has no process groups to read, and reports
 * none. */
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { basename } from 'node:path';

/** One live (not zombie) member of a process group. */
export interface GroupProcess { ppid: number; name: string }

/** The live members of process group `pgid`: parent and command name. */
export async function processGroup(pgid: number, platform: NodeJS.Platform = process.platform): Promise<Map<number, GroupProcess>> {
  const members = new Map<number, GroupProcess>();
  if (platform === 'win32' || !Number.isInteger(pgid) || pgid <= 1) return members;
  if (platform === 'linux') {
    const entries = await readdir('/proc').catch(() => [] as string[]);
    await Promise.all(entries.filter((name) => /^\d+$/.test(name)).map(async (name) => {
      const stat = await readFile(`/proc/${name}/stat`, 'utf8').catch(() => undefined);
      if (!stat) return;
      // `pid (comm) state ppid pgrp ...`; comm may hold spaces and parens.
      const close = stat.lastIndexOf(')');
      const fields = stat.slice(close + 2).split(' ');
      if (fields[0] !== 'Z' && Number(fields[2]) === pgid) {
        members.set(Number(name), { ppid: Number(fields[1]), name: stat.slice(stat.indexOf('(') + 1, close) });
      }
    }));
    return members;
  }
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat=,comm='], { timeout: 5_000 }, (error, stdout) => {
      if (!error) {
        for (const line of stdout.split('\n')) {
          const [pid, ppid, group, state, ...command] = line.trim().split(/\s+/);
          if (Number(group) === pgid && !state?.startsWith('Z')) members.set(Number(pid), { ppid: Number(ppid), name: basename(command.join(' ')) });
        }
      }
      resolve(members);
    });
  });
}

/** The live members' pids. */
export async function processGroupMembers(pgid: number, platform: NodeJS.Platform = process.platform): Promise<Set<number>> {
  return new Set((await processGroup(pgid, platform)).keys());
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ash', 'ksh', 'mksh', 'fish', 'tcsh', 'csh', 'pwsh']);
/** Whether `name` (a process's command name) is a shell; a login shell's
 * leading `-` is ignored. */
export function isShellName(name: string): boolean {
  return SHELLS.has(name.replace(/^-/, ''));
}

/** Of `candidates` (processes a turn started and left running), those that
 * are work a tool call left running, in the vendor `root`'s current `group`:
 *
 *  - below a shell that is itself one of the candidates -- a command the
 *    vendor ran during a turn (`bash -c 'npm run dev'`, Claude Code's
 *    `run_in_background` wrapper, Gemini's `bash -c`) and what it started.
 *    The shell alone is not work: an idle shell a vendor keeps for its next
 *    command (Copilot's bash sessions) is waiting, not running anything;
 *  - or no longer below the vendor at all: the shell that started it exited
 *    and it was reparented (`nohup server &`, `setsid`-less daemons) -- the
 *    vendor's own helpers are its children, it talks to them over pipes.
 *
 * Why this cannot count an MCP server, a language server or any other helper
 * the vendor itself runs: the vendor spawns those directly (stdio transport:
 * it holds their pipes), so walking up from one reaches `root` with no shell
 * on the way -- whether it started before the prompt or lazily during it.
 * A helper launched through `sh -c '<one command>'` does not change that:
 * the shell execs the command in its place. And anything present before the
 * turn's prompt (the vendor, a launcher script) is never a candidate. */
export function toolCallWork(group: ReadonlyMap<number, GroupProcess>, root: number, candidates: ReadonlySet<number>): Set<number> {
  const work = new Set<number>();
  for (const pid of candidates) {
    if (pid === root || !group.has(pid)) continue;
    const seen = new Set<number>([pid]);
    for (let parent = group.get(pid)!.ppid; ; parent = group.get(parent)!.ppid) {
      if (parent === root) break;
      const above = group.get(parent);
      // Left the group below the vendor: reparented, its starter gone.
      if (!above) { work.add(pid); break; }
      if (seen.has(parent)) break;
      // A tool call's shell is one the vendor's agent started itself: its parent is the vendor or
      // the agent directly under it (the Claude CLI below claude-agent-acp). A shell further down
      // is a helper's own launcher -- `npm exec` runs an MCP server through `sh -c` -- and made
      // every worker whose vendor respawned mid-turn wait on its MCP servers forever (MEASURED
      // 2026-10-10: seven workers two days old, each `held: retiring once the vendor's work ends`).
      if (candidates.has(parent) && isShellName(above.name) && (above.ppid === root || group.get(above.ppid)?.ppid === root)) { work.add(pid); break; }
      seen.add(parent);
    }
  }
  return work;
}

/** Whether process `pid` is still alive. */
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Live processes whose environment holds `name=value`: whatever a child
 * started, wherever it went -- a daemon that moved to a session of its own
 * (setsid) leaves the process group, but keeps the environment it was given.
 * Linux only (/proc); elsewhere none are found. */
export async function processesWithEnvironment(name: string, value: string, platform: NodeJS.Platform = process.platform): Promise<number[]> {
  if (platform !== 'linux') return [];
  const needle = `\0${name}=${value}\0`;
  const entries = await readdir('/proc').catch(() => [] as string[]);
  const found: number[] = [];
  await Promise.all(entries.filter((entry) => /^\d+$/.test(entry) && Number(entry) !== process.pid).map(async (entry) => {
    const environment = await readFile(`/proc/${entry}/environ`, 'latin1').catch(() => undefined);
    if (environment && `\0${environment}`.includes(needle)) found.push(Number(entry));
  }));
  return found;
}
