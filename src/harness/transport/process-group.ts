/** Which processes belong to a vendor child's process group.
 *
 * A persistent vendor (ACP, Codex app-server) is spawned detached, so it and
 * everything it starts share its process group. Work it leaves running
 * between turns -- Claude Code's `run_in_background` shell under ACP, a dev
 * server -- reports as a finished tool call ("started in the background") and
 * nothing in the protocol says it is still going. Its processes do: the one
 * signal that is the same for every vendor. Read from /proc on Linux (no
 * process spawned), from one `ps` elsewhere on Unix; Windows has no process
 * groups to read, and reports none. */
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';

/** The live (not zombie) members of process group `pgid`. */
export async function processGroupMembers(pgid: number, platform: NodeJS.Platform = process.platform): Promise<Set<number>> {
  if (platform === 'win32' || !Number.isInteger(pgid) || pgid <= 1) return new Set();
  if (platform === 'linux') {
    const members = new Set<number>();
    const entries = await readdir('/proc').catch(() => [] as string[]);
    await Promise.all(entries.filter((name) => /^\d+$/.test(name)).map(async (name) => {
      const stat = await readFile(`/proc/${name}/stat`, 'utf8').catch(() => undefined);
      if (!stat) return;
      // `pid (comm) state ppid pgrp ...`; comm may hold spaces and parens.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (fields[0] !== 'Z' && Number(fields[2]) === pgid) members.add(Number(name));
    }));
    return members;
  }
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,pgid=,stat='], { timeout: 5_000 }, (error, stdout) => {
      const members = new Set<number>();
      if (!error) {
        for (const line of stdout.split('\n')) {
          const [pid, group, state] = line.trim().split(/\s+/);
          if (Number(group) === pgid && !state?.startsWith('Z')) members.add(Number(pid));
        }
      }
      resolve(members);
    });
  });
}

/** Whether process `pid` is still alive. */
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
