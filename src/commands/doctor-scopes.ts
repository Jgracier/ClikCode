/** `clikcode doctor scopes [--reap]`: every ClikCode cgroup with its session, memory, tasks, cpu, age and owner; flags what has
 * outlived its use; `--reap` ends only the flagged cgroups, after printing them. */
import { readState } from '../session/state/read.js';
import { commandMaxMs } from '../worker/command-lifetime.js';
import { AGENT_SLICE } from '../worker/own-scope.js';
import { reap, reapTargets, renderScopeReport, scanSlice } from '../worker/scope-report.js';

export function agentSliceFor(uid: number): string {
  return `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/${AGENT_SLICE}`;
}

export async function aiDoctorScopes(options: { reap?: boolean }): Promise<void> {
  if (process.platform !== 'linux') { process.stdout.write('Scopes are a Linux (systemd) feature; nothing to list here.\n'); return; }
  const names = new Map<string, string>();
  try { for (const session of (await readState({ transcripts: [] })).sessions) if (session.name) names.set(session.id, session.name); } catch { /* names are a nicety */ }
  const rows = await scanSlice(agentSliceFor(process.getuid?.() ?? 0), { names });
  process.stdout.write(`${renderScopeReport(rows, commandMaxMs())}\n`);
  const targets = reapTargets(rows);
  if (!targets.length) { process.stdout.write('\nNothing is flagged.\n'); return; }
  process.stdout.write(`\nFlagged (${targets.length}):\n${targets.map((target) => `  ${target.label}: ${target.why}`).join('\n')}\n`);
  if (!options.reap) { process.stdout.write('Run `clikcode doctor scopes --reap` to end these cgroups (and nothing else).\n'); return; }
  const ended = reap(targets);
  process.stdout.write(`Ended ${ended.length} of ${targets.length}: ${ended.join(', ') || 'none'}\n`);
}
