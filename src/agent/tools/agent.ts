/** A coding subagent runs the same local tools with the parent's approvals.
 * Its write class makes the parent run it alone, in call order -- unless it
 * is isolated in its own git worktree, where it touches nothing the parent's
 * other calls can see, so several run at once. A background agent is always
 * isolated, and agent_send / agent_wait reach it while it runs. */
import { defineTool } from '../tool-contract.js';
import { formatToolRow } from '../../harness/protocol/tools.js';
import { canCreateAgentWorktree } from '../worktree.js';

interface AgentArgs { prompt: string; description?: string; isolation?: 'worktree'; background?: boolean }

export const agentTool = defineTool<AgentArgs>({
  name: 'agent',
  class: 'write',
  description: [
    'Delegate a self-contained coding task to a subagent. It can read, edit and run commands under this conversation\'s permissions.',
    'It sees the project instructions but not this conversation; include the task, files, constraints and expected result.',
    'By default it works in this working tree, its file edits belong to this turn\'s undo checkpoint, and it runs serially with other writes.',
    'With isolation "worktree" (git repositories only) it works in a fresh git worktree on a new branch from HEAD, without this tree\'s uncommitted changes; its result names the branch and summarizes the diff (a worktree with no changes is removed). Several isolated agent calls in one step run in parallel.',
    'With background true (implies isolation "worktree") the call returns an id at once and the agent works while you continue: agent_send gives it a follow-up instruction, agent_wait gets its result, and a result you did not wait for arrives as a message. This turn does not end while a background agent runs.',
  ].join(' '),
  parameters: {
    type: 'object', additionalProperties: false, required: ['prompt'],
    properties: {
      prompt: { type: 'string', description: 'Complete coding task for the subagent.' },
      description: { type: 'string', description: 'Short label shown to the user.' },
      isolation: { type: 'string', enum: ['worktree'], description: 'Run in its own git worktree and branch, so it can run in parallel with other agents.' },
      background: { type: 'boolean', description: 'Return an id at once and run in the background, in its own worktree.' },
    },
  },
  label: (args) => formatToolRow('agent', args.description?.trim() || args.prompt),
  concurrent: (args) => args?.isolation === 'worktree' || args?.background === true,
  async run(args, ctx) {
    if (!ctx.runSubagent) return { output: 'A subagent cannot start another subagent.', isError: true };
    const description = args.description?.trim();
    const request = {
      prompt: args.prompt, kind: 'work' as const,
      ...(description ? { description } : {}),
      ...(args.isolation === 'worktree' || args.background ? { isolation: 'worktree' as const } : {}),
    };
    if (!args.background) return ctx.runSubagent(request);
    if (!ctx.agents) return { output: 'Background agents are not available here.', isError: true };
    // Refused now rather than as the agent's first and only result.
    if (!await canCreateAgentWorktree(ctx.cwd)) return { output: `A background agent works in its own git worktree, and ${ctx.cwd} is not in a git repository with a commit; run it in the foreground.`, isError: true };
    const runSubagent = ctx.runSubagent;
    const id = ctx.agents.start(description || args.prompt.split('\n')[0].slice(0, 80), (onSteerReady) => runSubagent({ ...request, background: true, onSteerReady }));
    return { output: `Started ${id} in the background, in its own worktree. Carry on; agent_send("${id}", ...) gives it more instructions, agent_wait("${id}") gets its result.` };
  },
});
