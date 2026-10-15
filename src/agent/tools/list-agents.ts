/** What background coding agents this conversation has: running, finished,
 * stopped or interrupted, and whether their result has reached the model.
 * They belong to the conversation, not to a turn: stopping a turn leaves them
 * running. Claude Code's ListAgents and Codex's list_agents, over
 * background-agents.ts and the on-disk record (agent-registry.ts). */
import { defineTool } from '../tool-contract.js';
import { readAgentRecords } from '../agent-registry.js';

export const listAgentsTool = defineTool<Record<string, never>>({
  name: 'list_agents',
  class: 'read',
  description: 'List the background agents of this conversation (agent with background: true), including ones an earlier turn started: each one\'s id, what it was given, its branch, and whether it is running, finished, failed, stopped or interrupted. They keep running when a turn is stopped; only the user stops them. Use it to find an id for agent_send or agent_wait.',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  label: () => 'List background agents',
  async run(_args, ctx) {
    const live = ctx.agents?.list() ?? [];
    const known = new Set(live.map((agent) => agent.id));
    // Agents an earlier worker ran, found on disk.
    const earlier = readAgentRecords(ctx.stateDir, ctx.sessionId).filter((record) => !known.has(record.id));
    if (!live.length && !earlier.length) return { output: 'No background agents have been started.' };
    const lines = live.map((agent) => `${agent.id}  ${agent.status}${agent.status !== 'running' ? (agent.delivered ? ', result delivered' : ', result not yet delivered') : ''}${agent.branch ? `  [${agent.branch}]` : ''}  ${agent.label}`);
    for (const record of earlier) lines.push(`${record.id}  ${record.status} (earlier worker)${record.worktree ? `  [${record.worktree.branch}]` : ''}  ${record.label}`);
    return { output: lines.join('\n') };
  },
});
