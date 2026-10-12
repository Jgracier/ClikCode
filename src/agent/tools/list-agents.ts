/** What background coding agents this turn has: running, finished, and whether
 * their result has reached the model. Claude Code's ListAgents and Codex's
 * list_agents, over background-agents.ts. */
import { defineTool } from '../tool-contract.js';

export const listAgentsTool = defineTool<Record<string, never>>({
  name: 'list_agents',
  class: 'read',
  description: 'List the background agents started this turn (agent with background: true): each one\'s id, what it was given, and whether it is running, finished or failed. Use it to find an id for agent_send or agent_wait.',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  label: () => 'List background agents',
  async run(_args, ctx) {
    const agents = ctx.agents?.list() ?? [];
    if (!agents.length) return { output: 'No background agents have been started.' };
    return { output: agents.map((agent) => `${agent.id}  ${agent.status}${agent.status !== 'running' ? (agent.delivered ? ', result delivered' : ', result not yet delivered') : ''}  ${agent.label}`).join('\n') };
  },
});
