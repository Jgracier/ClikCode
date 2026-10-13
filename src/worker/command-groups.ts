/** A cgroup for each command shell the worker can observe, inside its
 * conversation's scope. Stopping one ends its processes only.
 *
 * The worker's scope (own-scope.ts) is delegated to it. The worker, the
 * vendor and MCP servers live in `agent/`; each command in a `cmd-<pid>/` of
 * its own. A command is a shell the agent started -- a vendor's Bash tool,
 * ClikCode's own shell tool, a background shell -- moved there by the sweep
 * within a second of starting, with every process it had started by then;
 * whatever it starts afterwards is born there. Memory allocated before the
 * move stays charged to the old group, so resource-probes.ts reads process
 * PSS as well. Shells that exec or finish before the sweep are not grouped
 * and are never automatic stop candidates. Its group goes once empty.
 * Measured instead of guessed because guessing failed: 2026-10-13, a
 * guard summing per-process RSS over /proc trees stopped 70 agents' `sleep`s
 * while the memory sat in processes it could not see. */
import { mkdirSync, readdirSync, readFileSync, readlinkSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const AGENT_GROUP = 'agent';
export const COMMAND_GROUP = /^cmd-\d+$/;
const SHELLS = new Set(['bash', 'sh', 'dash', 'zsh', 'fish', 'ksh', 'mksh', 'busybox', 'cmd', 'powershell', 'pwsh']);
/** A shell that only starts an MCP server (`sh -c npx some-mcp`): agent machinery, not a command. */
const MCP = /(?:^|[\s/@_-])mcp(?:$|[\s/._-])|-mcp\b|\bmcp-/i;

export interface ProcInfo { pid: number; ppid: number; exe: string; command: string }
export type ProcReader = (pid: number) => ProcInfo | undefined;

export const readProc: ProcReader = (pid) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    let exe = '';
    try { exe = readlinkSync(`/proc/${pid}/exe`).split('/').pop()!.replace(/ \(deleted\)$/, ''); } catch { /* fail-open-ok: a zombie has no exe, and is no shell */ }
    const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
    return { pid, ppid, exe, command };
  } catch { return undefined; }
};

export function groupPids(dir: string): number[] {
  try { return readFileSync(join(dir, 'cgroup.procs'), 'utf8').split('\n').filter(Boolean).map(Number); } catch { return []; }
}

/** Puts this process in the scope's agent group and lets the worker give each
 * command a group of its own. False when the scope cannot be divided (not
 * delegated, a systemd without it): its commands then stay in one group. */
export function divideScope(scopeDir: string, pid: number = process.pid): boolean {
  try {
    mkdirSync(join(scopeDir, AGENT_GROUP), { recursive: true });
    writeFileSync(join(scopeDir, AGENT_GROUP, 'cgroup.procs'), String(pid));
    writeFileSync(join(scopeDir, 'cgroup.subtree_control'), '+memory +pids');
    return true;
  } catch { return false; }
}

/** The commands among the agent group's processes: each shell whose parent is
 * not a shell (the agent's own process started it), with every process below it. */
export function findCommands(entries: readonly ProcInfo[]): { root: ProcInfo; pids: number[] }[] {
  const byPid = new Map(entries.map((entry) => [entry.pid, entry]));
  const children = new Map<number, ProcInfo[]>();
  for (const entry of entries) children.set(entry.ppid, [...(children.get(entry.ppid) ?? []), entry]);
  const commands: { root: ProcInfo; pids: number[] }[] = [];
  for (const entry of entries) {
    const parent = byPid.get(entry.ppid);
    if (!SHELLS.has(entry.exe) || (parent && SHELLS.has(parent.exe)) || MCP.test(entry.command)) continue;
    // An MCP server may itself launch a shell. Its work is agent machinery,
    // not a command the model asked to run.
    let ancestor = parent;
    let fromMcp = false;
    while (ancestor) {
      if (MCP.test(ancestor.command)) { fromMcp = true; break; }
      ancestor = byPid.get(ancestor.ppid);
    }
    if (fromMcp) continue;
    const pids: number[] = [];
    const stack = [entry];
    while (stack.length) { const next = stack.pop()!; pids.push(next.pid); stack.push(...(children.get(next.pid) ?? [])); }
    commands.push({ root: entry, pids });
  }
  return commands;
}

/** What the agent ran, as it wrote it: the shell's script without the
 * wrappers a vendor puts around it (`bash -c`, a shell snapshot, `eval '...'`). */
export function commandLabel(command: string): string {
  let text = command.replace(/^\S*\b(?:ba|z|da|k|mk)?sh\s+(?:-\w+\s+)*-c\s+/, '');
  text = text.replace(/^source\s+\S+\s*(?:2>\/dev\/null\s*)?(?:\|\|\s*true\s*)?&&\s*/, '');
  const evaled = /^(?:shopt[^&]*&&\s*)?eval\s+'((?:[^']|'\\'')*)'/.exec(text);
  if (evaled) text = evaled[1]!.replace(/'\\''/g, "'");
  text = text.replace(/\s*<\s*\/dev\/null\s*&&\s*pwd -P\s*>\|?\s*\S+\s*$/, '').trim();
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

const WRAPPER = /__grok_user_cmd|builtin read -r/;

/** The program the agent started, not the vendor's shell wrapper and not a
 * cgroup id. A child program wins; a remembered label covers a shell that
 * has already exited. */
export function bestLabel(root: ProcInfo | undefined, descendants: readonly ProcInfo[], remembered?: string): string {
  const program = descendants.find((entry) => !SHELLS.has(entry.exe) && entry.command && !MCP.test(entry.command));
  if (program) return commandLabel(program.command);
  const fromRoot = root ? commandLabel(root.command) : '';
  if (fromRoot && !WRAPPER.test(fromRoot)) return fromRoot;
  if (remembered && !WRAPPER.test(remembered)) return remembered;
  return '';
}

export interface CommandSweep {
  /** What each command group's agent ran, by group name. */
  readonly labels: ReadonlyMap<string, string>;
  sweep(): void;
}

export function createCommandSweep(scopeDir: string, read: ProcReader = readProc): CommandSweep {
  const labels = new Map<string, string>();
  return {
    labels,
    sweep() {
      const entries = groupPids(join(scopeDir, AGENT_GROUP)).map(read).filter((entry): entry is ProcInfo => !!entry);
      for (const command of findCommands(entries)) {
        const name = `cmd-${command.root.pid}`;
        try { mkdirSync(join(scopeDir, name), { recursive: true }); } catch { continue; }
        for (const pid of command.pids) {
          try { writeFileSync(join(scopeDir, name, 'cgroup.procs'), String(pid)); } catch { /* fail-open-ok: it exited between listing and moving */ }
        }
        labels.set(name, commandLabel(command.root.command));
      }
      let groups: string[] = [];
      try { groups = readdirSync(scopeDir).filter((name) => COMMAND_GROUP.test(name)); } catch { /* fail-open-ok: the scope is going away with the worker */ }
      for (const name of groups) {
        if (!/^populated 0$/m.test(readFileSync(join(scopeDir, name, 'cgroup.events'), 'utf8'))) continue;
        try { rmdirSync(join(scopeDir, name)); labels.delete(name); } catch { /* fail-open-ok: a process arrived meanwhile; next sweep */ }
      }
    },
  };
}
