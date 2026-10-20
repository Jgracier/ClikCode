/** `/agents`: the user's own view of, and the only way to stop, a conversation's
 * background agents. Esc, Ctrl+C, a closing window and a newer build never end
 * them (agent/background-agents.ts); this does, after naming what it ends. */
import { existingSessionAgents } from '../agent/background-agents.js';
import { readAgentRecords } from '../agent/agent-registry.js';
import { stateDirectory } from '../session/store/paths.js';
import { lifecycle } from '../runtime/lifecycle-log.js';
import type { AgentSummary, ClientCommand, WorkerEvent } from './protocol.js';
import type { WorkerContext } from './worker-context.js';

const minutes = (since: number): string => {
  const seconds = Math.max(0, Math.round((Date.now() - since) / 1000));
  return seconds >= 120 ? `${Math.round(seconds / 60)} min` : `${seconds}s`;
};

const line = (agent: AgentSummary): string => `${agent.id}  ${agent.status}  ${agent.label}${agent.branch ? `  [${agent.branch}]` : ''}  (${minutes(agent.startedAt)})`;

export function agentsReport(running: readonly AgentSummary[], others: readonly AgentSummary[]): string {
  if (!running.length && !others.length) return 'No background agents.';
  return [
    running.length ? `Running (Esc and Ctrl+C do not stop these):\n${running.map(line).join('\n')}` : 'Nothing is running.',
    ...(others.length ? [`Ended:\n${others.map(line).join('\n')}`] : []),
    ...(running.length ? ['Stop one with /agents stop <id>, or all with /agents stop all (asks first).'] : []),
  ].join('\n\n');
}

function stopConfirmation(targets: readonly AgentSummary[]): string {
  return `This would stop ${targets.length} running agent${targets.length === 1 ? '' : 's'}: ${targets.map((agent) => `${agent.id} (${agent.label})`).join(', ')}. Their work so far is committed to their branches. Confirm with: /agents stop ${targets.length === 1 ? targets[0]!.id : 'all'} confirm`;
}

export function createAgentsCommand(ctx: WorkerContext) {
  const summaries = (): { running: AgentSummary[]; others: AgentSummary[] } => {
    const agents = existingSessionAgents(ctx.agentSession)?.list() ?? [];
    const known = new Set(agents.map((agent) => agent.id));
    const all: AgentSummary[] = agents.map((agent) => ({ id: agent.id, label: agent.label, status: agent.status, startedAt: agent.startedAt, ...(agent.branch ? { branch: agent.branch } : {}) }));
    for (const record of readAgentRecords(stateDirectory(), ctx.sessionId)) {
      if (!known.has(record.id)) all.push({ id: record.id, label: record.label, status: record.status, startedAt: record.startedAt, ...(record.worktree ? { branch: record.worktree.branch } : {}) });
    }
    return { running: all.filter((agent) => agent.status === 'running'), others: all.filter((agent) => agent.status !== 'running') };
  };

  return async (command: Extract<ClientCommand, { type: 'agents' }>): Promise<Extract<WorkerEvent, { type: 'agents' }>> => {
    const { running, others } = summaries();
    if (command.action === 'list') return { type: 'agents', outcome: 'listed', running, text: agentsReport(running, others) };
    const targets = command.all ? running : running.filter((agent) => command.ids?.includes(agent.id));
    if (!targets.length) {
      const named = command.ids?.length ? ` named ${command.ids.join(', ')}` : '';
      return { type: 'agents', outcome: 'none', running, text: `No running agent${named} to stop.\n\n${agentsReport(running, others)}` };
    }
    // The stop names what it ends and waits for the user's yes: no key, signal or
    // other client ends an agent, and neither does a stop that was not confirmed.
    if (!command.confirm) return { type: 'agents', outcome: 'needs-confirm', running, text: stopConfirmation(targets) };
    const agents = existingSessionAgents(ctx.agentSession);
    lifecycle('worker.agents.stop', { agents: targets.map((agent) => agent.id).join(','), all: Boolean(command.all) });
    const stopped: string[] = [];
    for (const target of targets) if (await agents?.stop(target.id, 'stopped by you')) stopped.push(target.id);
    return { type: 'agents', outcome: 'stopped', running: summaries().running, stopped, text: `Stopped ${stopped.join(', ') || 'nothing'}. Their work is committed to their branches.` };
  };
}
