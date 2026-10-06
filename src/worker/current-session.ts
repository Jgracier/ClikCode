/** Which ClikCode conversation a helper process (an MCP server a vendor
 * spawned) is running for, found with no stored state. The vendor is spawned
 * by that conversation's worker (`clikcode session-worker <id>`) and spawns
 * the helper, so the id is CLIKCODE_SESSION_ID when it survived the vendor's
 * environment filtering, else the nearest `session-worker <id>` in the
 * process ancestry. Two conversations never see each other's id. */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** The session id a `session-worker <id>` argv names. */
export function workerSessionFromArgv(argv: readonly string[]): string | undefined {
  const at = argv.indexOf('session-worker');
  const id = at >= 0 ? argv[at + 1] : undefined;
  return id && !id.startsWith('-') ? id : undefined;
}

function parentAndArgv(pid: number): { ppid: number; argv: string[] } | undefined {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // The command name is in parentheses and may hold spaces: fields
      // after the last `)` are fixed. State, then the parent pid.
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      return Number.isFinite(ppid) ? { ppid, argv } : undefined;
    }
    if (process.platform === 'win32') return undefined;
    const line = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim();
    const match = /^(\d+)\s+(.*)$/.exec(line);
    return match ? { ppid: Number(match[1]), argv: match[2]!.split(/\s+/) } : undefined;
  } catch {
    return undefined;
  }
}

/** The ClikCode conversation this process was started for, if any. */
export function currentConversationSession(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const named = env.CLIKCODE_SESSION_ID?.trim();
  if (named) return named;
  let pid = process.ppid;
  for (let hop = 0; hop < 12 && pid > 1; hop += 1) {
    const found = parentAndArgv(pid);
    if (!found) return undefined;
    const id = workerSessionFromArgv(found.argv);
    if (id) return id;
    pid = found.ppid;
  }
  return undefined;
}
