/** Background work a vendor says is still running (standard section 10),
 * read from the wire shapes the vendor publishes. Named agents are kept
 * when the vendor sends its task list; count-only records still carry counts.
 * A record that does not carry a count says nothing, which is not zero.
 *
 * Three kinds, because Claude Code and Codex treat them as three things:
 *  - `agents`: background agents. On the turn's end line (`Waiting for N
 *    background agents`).
 *  - `workflows`: dynamic workflows (Claude Code's `local_workflow`). On the
 *    end line too, after the agents (`... and 1 dynamic workflow`).
 *  - `terminals`: background shells / terminals. A footer indicator while any
 *    run, never part of the end line (Claude Code's own count leaves shells
 *    out, and Codex counts "background terminals" apart from the turn).
 *
 * Claude Code publishes two records, both in its own SDK / CLI:
 *  - `system/background_tasks_changed {tasks:[{task_id, task_type,
 *    description, ambient?, parent_task_id?, subagent_type?}]}` -- the FULL
 *    set of live background tasks, emitted on every change
 *    (SDKBackgroundTasksChangedMessage; replace, never pair edges). Its own
 *    counting (the `pendingAgents`/`pendingWorkflows` of its turn-end line,
 *    and the shell count of its tasks pill): agents are `local_agent` tasks
 *    that are not `ambient` and not the backgrounded main session; workflows
 *    are `local_workflow`; shells are `local_bash` that no agent owns
 *    (`parent_task_id` absent). `monitor_mcp` / `monitor_ws` are monitors and
 *    `in_process_teammate` a teammate: none of the three. A shell started by
 *    the Monitor tool is a `local_bash` too, and the wire does not say which
 *    it is (the `kind` is only in the CLI's internal metadata).
 *  - `system/turn_duration {durationMs, messageCount,
 *    pendingBackgroundAgentCount?, pendingWorkflowCount?}` -- the CLI's own
 *    end-of-turn record; a count that is zero is left out of it. */
import { asRecord, type JsonRecord } from './json-lines.js';

/** A background command by its pid, as a surface says what it is waiting on (transport/background-commands.ts).
 * Times are epoch ms. */
export interface BackgroundCommand {
  pid: number;
  pgid?: number;
  label: string;
  startedAt?: number;
  /** Cpu use over the last look, percent of one core. */
  cpuPercent?: number;
  /** When its output file last changed; absent: it has written nothing. */
  lastOutputAt?: number;
  /** Why it is stale (it has outlived its use), when it is. */
  stale?: string;
}

/** The background work a surface shows. A kind that is zero is absent. */
export interface BackgroundWork {
  agents?: number;
  /** Named live agents when the vendor publishes its full task list. */
  agentTasks?: Array<{ id: string; label: string }>;
  terminals?: number;
  /** The terminals' commands by pid, when they could be read: what a status line names. */
  commands?: BackgroundCommand[];
  workflows?: number;
}

/** What one vendor record says: each kind it names, zero included (a level
 * that lists no terminal says there are none). */
export type BackgroundWorkUpdate = BackgroundWork;

const KINDS = ['agents', 'terminals', 'workflows'] as const;

const wholeCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;

/** `current` with the kinds `update` names replaced and zeros dropped;
 * undefined when nothing is left. */
export function mergeBackgroundWork(current: BackgroundWork | undefined, update: BackgroundWorkUpdate): BackgroundWork | undefined {
  const merged: BackgroundWork = {};
  for (const kind of KINDS) {
    const count = wholeCount(update[kind] !== undefined ? update[kind] : current?.[kind]);
    if (count) merged[kind] = count;
  }
  if (merged.agents) {
    const tasks = update.agentTasks ?? (update.agents === undefined || update.agents === current?.agents ? current?.agentTasks : undefined);
    if (tasks?.length) merged.agentTasks = tasks.slice(0, merged.agents);
  }
  const commands = update.commands !== undefined ? update.commands : current?.commands;
  if (merged.terminals && commands?.length) merged.commands = commands;
  return Object.keys(merged).length ? merged : undefined;
}

/** The work a saved turn, live turn or event carries: its `background`, else
 * (data from before there were three kinds) `pendingBackground`, which was
 * the agents. */
export function backgroundWorkOf(holder: { background?: BackgroundWork; pendingBackground?: number } | undefined): BackgroundWork | undefined {
  if (!holder) return undefined;
  return mergeBackgroundWork(undefined, holder.background ?? { agents: holder.pendingBackground ?? 0 });
}

export function backgroundWork(record: JsonRecord): BackgroundWorkUpdate | undefined {
  if (record.type !== 'system') return undefined;
  if (record.subtype === 'background_tasks_changed' && Array.isArray(record.tasks)) {
    const work: BackgroundWorkUpdate = { agents: 0, terminals: 0, workflows: 0 };
    const agentTasks: NonNullable<BackgroundWork['agentTasks']> = [];
    for (const task of record.tasks) {
      const value = asRecord(task);
      if (!value) continue;
      if (value.task_type === 'local_agent') {
        if (value.ambient !== true && value.subagent_type !== 'main-session') {
          work.agents = (work.agents ?? 0) + 1;
          const id = value.task_id;
          if (typeof id === 'string' && id) agentTasks.push({ id, label: typeof value.description === 'string' && value.description.trim() ? value.description.trim() : 'Background agent' });
        }
      } else if (value.task_type === 'local_workflow') work.workflows = (work.workflows ?? 0) + 1;
      else if (value.task_type === 'local_bash') {
        const owner = value.parent_task_id;
        if (typeof owner !== 'string' || !owner) work.terminals = (work.terminals ?? 0) + 1;
      }
    }
    if (agentTasks.length) work.agentTasks = agentTasks;
    return work;
  }
  if (record.subtype === 'turn_duration') {
    const agents = wholeCount(record.pendingBackgroundAgentCount);
    const workflows = wholeCount(record.pendingWorkflowCount);
    if (agents === undefined && workflows === undefined) return undefined;
    // One result of the CLI's own count: a kind it leaves out is zero.
    return { agents: agents ?? 0, workflows: workflows ?? 0 };
  }
  return undefined;
}
